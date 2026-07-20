package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/aperswal/openbugbot-oss/internal/enrollment"
)

func main() {
	login := flag.Bool("login", false, "store and enroll the current Codex session")
	githubLogin := flag.String("github", "", "require this GitHub login to match the current gh account")
	flag.Parse()

	if !*login {
		fmt.Fprintln(os.Stderr, "usage: openbugbot --login [--github LOGIN]")
		os.Exit(2)
	}

	if err := enrollment.Login(enrollment.Options{GitHubLogin: *githubLogin}); err != nil {
		fmt.Fprintln(os.Stderr, "openbugbot:", err)
		var usageError *enrollment.UsageError
		if errors.As(err, &usageError) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}
