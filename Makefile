COMPOSE := docker compose -f deploy/docker-compose.yml

.PHONY: help up down seed demo test fmt vet page logs clean

help:
	@echo "up     start postgres, redis and both services"
	@echo "seed   load the demo repo, users and roles"
	@echo "demo   run both MVP demos against the running stack"
	@echo "page   open the status page"
	@echo "test   run every Go test (no services needed)"
	@echo "down   stop the stack"
	@echo "clean  stop the stack and delete its data"

up:
	$(COMPOSE) up --build -d
	@echo "permissiond   http://127.0.0.1:8081/healthz"
	@echo "coordinationd http://127.0.0.1:8082/healthz"

seed:
	$(COMPOSE) run --rm seed

demo:
	./scripts/demo.sh

page:
	open demo/index.html

test:
	cd services/permission   && go test -race -count=1 ./...
	cd services/coordination && go test -race -count=1 ./...

fmt:
	gofmt -w services/

vet:
	cd services/permission   && go vet ./...
	cd services/coordination && go vet ./...

logs:
	$(COMPOSE) logs -f permissiond coordinationd

down:
	$(COMPOSE) down

clean:
	$(COMPOSE) down -v
