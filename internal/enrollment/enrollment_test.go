package enrollment

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"testing"
)

func TestEnrollmentConfigurationIsRequired(t *testing.T) {
	t.Setenv("OPENBUGBOT_AUTH_PUBLIC_KEY", "")
	t.Setenv("OPENBUGBOT_AUTH_PUBLIC_KEY_FILE", "")
	t.Setenv("OPENBUGBOT_ENROLL_URL", "")

	if _, err := enrollmentPublicKey(); err == nil {
		t.Fatal("enrollmentPublicKey() succeeded without configuration")
	}
	if _, err := enrollmentEndpoint(); err == nil {
		t.Fatal("enrollmentEndpoint() succeeded without configuration")
	}
}

func TestEncryptUsesHybridEnvelope(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))
	input := []byte(`{"tokens":{"access_token":"` + string(make([]byte, 512)) + `"}}`)

	encoded, err := encrypt(input, publicPEM)
	if err != nil {
		t.Fatal(err)
	}
	var envelope encryptionEnvelope
	if err := json.Unmarshal([]byte(encoded), &envelope); err != nil {
		t.Fatal(err)
	}
	encryptedKey, _ := base64.StdEncoding.DecodeString(envelope.EncryptedKey)
	symmetricKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, privateKey, encryptedKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(symmetricKey)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce, _ := base64.StdEncoding.DecodeString(envelope.Nonce)
	ciphertext, _ := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != string(input) {
		t.Fatal("decrypted auth does not match input")
	}
}

func TestEncryptLocalRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	input := []byte(`{"tokens":{"access_token":"example"}}`)

	encoded, err := encryptLocal(input, key)
	if err != nil {
		t.Fatal(err)
	}
	var envelope localEnvelope
	if err := json.Unmarshal([]byte(encoded), &envelope); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := base64.StdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != string(input) {
		t.Fatal("decrypted local auth does not match input")
	}
}
