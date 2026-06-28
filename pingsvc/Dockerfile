# pingsvc/Dockerfile
# Builder stage — use Go 1.24 or newer
FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git build-base

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build for the current platform
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /pingsvc ./cmd/pingsvc
# Runtime stage
FROM --platform=linux/amd64 alpine:3.18
RUN apk add --no-cache ca-certificates bash

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /home/appuser

COPY --from=builder /pingsvc /usr/local/bin/pingsvc
COPY wait-for-redis.sh /usr/local/bin/wait-for-redis.sh
RUN chmod +x /usr/local/bin/pingsvc /usr/local/bin/wait-for-redis.sh

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD [ "sh", "-c", "pgrep pingsvc || exit 1" ]

ENTRYPOINT ["/usr/local/bin/wait-for-redis.sh"]
CMD ["/usr/local/bin/pingsvc", "-targets", "/etc/pingsvc/targets.txt"]
