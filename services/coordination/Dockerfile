FROM golang:1.25-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/coordinationd ./cmd/coordinationd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/coordinationd /coordinationd
EXPOSE 8082
USER nonroot:nonroot
ENTRYPOINT ["/coordinationd"]
