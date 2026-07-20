package enrollment

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	serviceName = "openbugbot"
	keyName     = "codex-auth-encryption-key"
)

// UsageError indicates the person needs to provide setup information.
type UsageError struct{ message string }

func (e *UsageError) Error() string { return e.message }

type Options struct {
	GitHubLogin string
}

type enrollmentRequest struct {
	GitHubLogin   string `json:"github_login"`
	EncryptedAuth string `json:"encrypted_auth"`
}

type encryptionEnvelope struct {
	Ciphertext   string `json:"ciphertext"`
	EncryptedKey string `json:"encrypted_key"`
	Nonce        string `json:"nonce"`
}

type localEnvelope struct {
	Ciphertext string `json:"ciphertext"`
	Nonce      string `json:"nonce"`
}

// Login stores an encrypted local copy of the existing Codex credential, then
// optionally enrolls a separately encrypted copy for webhook-triggered reviews.
func Login(options Options) error {
	auth, err := readCodexAuth()
	if err != nil {
		return err
	}
	if err := storeLocalAuth(auth); err != nil {
		return err
	}

	login, token, err := githubIdentity(options.GitHubLogin)
	if err != nil {
		return err
	}
	publicKey, err := enrollmentPublicKey()
	if err != nil {
		return err
	}
	encrypted, err := encrypt(auth, publicKey)
	if err != nil {
		return err
	}
	endpoint, err := enrollmentEndpoint()
	if err != nil {
		return err
	}
	if err := enroll(endpoint, token, enrollmentRequest{
		GitHubLogin:   login,
		EncryptedAuth: encrypted,
	}); err != nil {
		return err
	}

	fmt.Printf("Codex auth stored securely and enrolled for @%s. OpenBugbot will now review their eligible pull requests automatically.\n", login)
	return nil
}

func storeLocalAuth(auth []byte) error {
	key, err := localEncryptionKey()
	if err != nil {
		return err
	}

	encoded, err := encryptLocal(auth, key)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("find home directory: %w", err)
	}
	dir := filepath.Join(home, ".openbugbot")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create local auth directory: %w", err)
	}
	temporary, err := os.CreateTemp(dir, "codex-auth-*.tmp")
	if err != nil {
		return fmt.Errorf("create encrypted auth file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect encrypted auth file: %w", err)
	}
	if _, err := temporary.WriteString(encoded); err != nil {
		temporary.Close()
		return fmt.Errorf("write encrypted auth file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close encrypted auth file: %w", err)
	}
	if err := os.Rename(temporaryName, filepath.Join(dir, "codex-auth.enc")); err != nil {
		return fmt.Errorf("store encrypted auth file: %w", err)
	}
	return nil
}

func localEncryptionKey() ([]byte, error) {
	encoded, err := keyring.Get(serviceName, keyName)
	if err == nil {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("read local encryption key from the OS keychain")
		}
		return key, nil
	}
	if err != keyring.ErrNotFound {
		return nil, fmt.Errorf("read local encryption key from the OS keychain: %w", err)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate local encryption key: %w", err)
	}
	if err := keyring.Set(serviceName, keyName, base64.StdEncoding.EncodeToString(key)); err != nil {
		return nil, fmt.Errorf("store local encryption key in the OS keychain: %w", err)
	}
	return key, nil
}

func encryptLocal(auth, key []byte) (string, error) {
	blockCipher, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create local auth cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(blockCipher)
	if err != nil {
		return "", fmt.Errorf("create local auth cipher mode: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate local auth nonce: %w", err)
	}
	encoded, err := json.Marshal(localEnvelope{
		Ciphertext: base64.StdEncoding.EncodeToString(gcm.Seal(nil, nonce, auth, nil)),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
	})
	if err != nil {
		return "", fmt.Errorf("encode local auth: %w", err)
	}
	return string(encoded), nil
}

func enrollmentPublicKey() (string, error) {
	if value := os.Getenv("OPENBUGBOT_AUTH_PUBLIC_KEY"); value != "" {
		return value, nil
	}
	path := os.Getenv("OPENBUGBOT_AUTH_PUBLIC_KEY_FILE")
	if path == "" {
		return "", &UsageError{message: "set OPENBUGBOT_AUTH_PUBLIC_KEY_FILE to your deployment's public encryption key"}
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read OPENBUGBOT_AUTH_PUBLIC_KEY_FILE: %w", err)
	}
	return string(value), nil
}

func enrollmentEndpoint() (string, error) {
	if endpoint := os.Getenv("OPENBUGBOT_ENROLL_URL"); endpoint != "" {
		return endpoint, nil
	}
	return "", &UsageError{message: "set OPENBUGBOT_ENROLL_URL to your deployment's /enroll endpoint"}
}

func readCodexAuth() ([]byte, error) {
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("find home directory: %w", err)
		}
		codexHome = filepath.Join(home, ".codex")
	}

	path := filepath.Join(codexHome, "auth.json")
	auth, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &UsageError{message: "no Codex auth.json found; run `codex login` first"}
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if !json.Valid(auth) {
		return nil, fmt.Errorf("%s is not valid JSON", path)
	}
	return auth, nil
}

func githubIdentity(expectedLogin string) (string, string, error) {
	token := os.Getenv("OPENBUGBOT_GITHUB_TOKEN")
	if token == "" {
		output, err := exec.Command("gh", "auth", "token").Output()
		if err != nil {
			return "", "", &UsageError{message: "could not read GitHub login; run `gh auth login` first"}
		}
		token = strings.TrimSpace(string(output))
	}
	if token == "" {
		return "", "", &UsageError{message: "GitHub returned an empty token; run `gh auth login` first"}
	}

	request, err := http.NewRequest(http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return "", "", fmt.Errorf("build GitHub identity request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("User-Agent", "openbugbot")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return "", "", fmt.Errorf("verify GitHub identity: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", &UsageError{message: "could not verify GitHub login; run `gh auth login` first"}
	}
	var account struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<10)).Decode(&account); err != nil {
		return "", "", fmt.Errorf("decode GitHub identity: %w", err)
	}
	login := strings.TrimSpace(account.Login)
	if login == "" {
		return "", "", &UsageError{message: "GitHub returned an empty login; run `gh auth login` first"}
	}
	if expectedLogin != "" && !strings.EqualFold(login, strings.TrimPrefix(expectedLogin, "@")) {
		return "", "", &UsageError{message: "--github must match the currently authenticated GitHub account"}
	}
	return login, token, nil
}

func encrypt(auth []byte, publicKeyPEM string) (string, error) {
	if publicKeyPEM == "" {
		return "", errors.New("OpenBugbot enrollment public key is unavailable")
	}
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return "", fmt.Errorf("OPENBUGBOT_AUTH_PUBLIC_KEY is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("parse enrollment public key: %w", err)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("enrollment public key must be RSA")
	}
	symmetricKey := make([]byte, 32)
	if _, err := rand.Read(symmetricKey); err != nil {
		return "", fmt.Errorf("generate enrollment encryption key: %w", err)
	}
	blockCipher, err := aes.NewCipher(symmetricKey)
	if err != nil {
		return "", fmt.Errorf("create enrollment cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(blockCipher)
	if err != nil {
		return "", fmt.Errorf("create enrollment cipher mode: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate enrollment nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, auth, nil)
	encryptedKey, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, symmetricKey, nil)
	if err != nil {
		return "", fmt.Errorf("encrypt enrollment key: %w", err)
	}
	envelope, err := json.Marshal(encryptionEnvelope{
		Ciphertext:   base64.StdEncoding.EncodeToString(ciphertext),
		EncryptedKey: base64.StdEncoding.EncodeToString(encryptedKey),
		Nonce:        base64.StdEncoding.EncodeToString(nonce),
	})
	if err != nil {
		return "", fmt.Errorf("encode encrypted enrollment: %w", err)
	}
	return string(envelope), nil
}

func enroll(endpoint, githubToken string, payload enrollmentRequest) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode enrollment request: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build enrollment request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+githubToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send encrypted enrollment: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	return fmt.Errorf("enrollment failed: %s: %s", response.Status, strings.TrimSpace(string(message)))
}
