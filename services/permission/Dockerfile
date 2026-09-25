FROM golang:1.25-alpine AS build
WORKDIR /src

# Dependencies first so a source-only change does not refetch the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/permissiond ./cmd/permissiond
RUN CGO_ENABLED=0 go build -trimpath -o /out/seed ./cmd/seed

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/permissiond /permissiond
COPY --from=build /out/seed /seed
EXPOSE 8081
USER nonroot:nonroot
ENTRYPOINT ["/permissiond"]
