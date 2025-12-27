package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ahimsalabs/durable-streams-go/durablestream"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	claudeDir := flag.String("dir", "", "claude directory (default: ~/.claude)")
	flag.Parse()

	dir := *claudeDir
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("get home dir: %v", err)
		}
		dir = filepath.Join(home, ".claude")
	}

	storage, err := NewClaudeStorage(dir)
	if err != nil {
		log.Fatalf("create storage: %v", err)
	}
	defer storage.Close()

	handler := durablestream.NewHandler(storage, nil)

	log.Printf("Claude durable stream server listening on %s", *addr)
	log.Printf("Watching: %s", dir)
	log.Printf("Streams: _history (command history), {conversation-id}")
	log.Printf("Example: curl %s/_history", *addr)

	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatalf("server: %v", err)
	}
}
