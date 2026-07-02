package main

import (
	"bytes"
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ObjectStore is the minimal interface the exporter needs to push spooled
// snapshots to durable storage. Backed by S3ObjectStore in production and
// an in-memory fake in tests (see exporter_test.go's fakeObjectStore). See
// plan/dynamic-hierarchy-multi-zone-architecture.md §4.4.
type ObjectStore interface {
	Put(ctx context.Context, key string, data []byte) error
}

// S3Config configures an S3-compatible object store. Endpoint is optional
// (empty = real AWS S3); set it to point at a self-hosted S3-compatible
// service (MinIO, etc.) for local development or testing. AccessKey/SecretKey
// are optional too -- when empty, the AWS SDK's default credential chain
// (env vars, shared config, IAM role) applies, which is the intended path
// for a real deployment's scoped IAM credential (plan §4.4).
type S3Config struct {
	Bucket    string
	Region    string
	Endpoint  string
	AccessKey string
	SecretKey string
}

type S3ObjectStore struct {
	client *s3.Client
	bucket string
}

func NewS3ObjectStore(ctx context.Context, cfg S3Config) (*S3ObjectStore, error) {
	optFns := []func(*config.LoadOptions) error{config.WithRegion(cfg.Region)}
	if cfg.AccessKey != "" && cfg.SecretKey != "" {
		optFns = append(optFns, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		))
	}

	awsCfg, err := config.LoadDefaultConfig(ctx, optFns...)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true
		}
	})

	return &S3ObjectStore{client: client, bucket: cfg.Bucket}, nil
}

func (s *S3ObjectStore) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("s3 put %s/%s: %w", s.bucket, key, err)
	}
	return nil
}
