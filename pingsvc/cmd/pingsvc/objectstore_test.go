package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestS3ObjectStore_Put_SendsExpectedRequest(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	store, err := NewS3ObjectStore(context.Background(), S3Config{
		Bucket:    "argus-metrics",
		Region:    "us-east-1",
		Endpoint:  server.URL,
		AccessKey: "test-access-key",
		SecretKey: "test-secret-key",
	})
	if err != nil {
		t.Fatalf("NewS3ObjectStore() error = %v", err)
	}

	if err := store.Put(context.Background(), "zone-1/2026/01/01/00/1000.json.gz", []byte(`{"hello":"world"}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want %q", gotMethod, http.MethodPut)
	}
	if gotPath != "/argus-metrics/zone-1/2026/01/01/00/1000.json.gz" {
		t.Errorf("path = %q, want %q", gotPath, "/argus-metrics/zone-1/2026/01/01/00/1000.json.gz")
	}
	if string(gotBody) != `{"hello":"world"}` {
		t.Errorf("body = %q, want %q", gotBody, `{"hello":"world"}`)
	}
}

func TestS3ObjectStore_Put_PropagatesServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	store, err := NewS3ObjectStore(context.Background(), S3Config{
		Bucket: "argus-metrics", Region: "us-east-1", Endpoint: server.URL,
		AccessKey: "test-access-key", SecretKey: "test-secret-key",
	})
	if err != nil {
		t.Fatalf("NewS3ObjectStore() error = %v", err)
	}

	if err := store.Put(context.Background(), "some/key.json.gz", []byte("data")); err == nil {
		t.Fatal("Put() error = nil, want an error on 500 response")
	}
}

func TestObjectKeyForSpoolFile(t *testing.T) {
	// 1700000000000ms = 2023-11-14T22:13:20Z
	got, err := objectKeyForSpoolFile("acme-corp", "zone-1", "1700000000000.json.gz")
	if err != nil {
		t.Fatalf("objectKeyForSpoolFile() error = %v", err)
	}
	want := "acme-corp/zone-1/2023/11/14/22/1700000000000.json.gz"
	if got != want {
		t.Errorf("objectKeyForSpoolFile() = %q, want %q", got, want)
	}
}

func TestObjectKeyForSpoolFile_InvalidFilenameReturnsError(t *testing.T) {
	if _, err := objectKeyForSpoolFile("acme-corp", "zone-1", "not-a-timestamp.json.gz"); err == nil {
		t.Fatal("objectKeyForSpoolFile() error = nil, want an error for a non-numeric filename")
	}
}
