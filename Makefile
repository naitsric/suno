# Suno Local — música generada con modelos locales (ACE-Step 1.5 + Next.js)
# Uso: make setup   → instala motor (clona + uv sync) y web (pnpm install)
#      make engine  → arranca la API de ACE-Step en :8001 (descarga modelos la 1ª vez)
#      make voice   → arranca el servicio de conversión de voz en :8002
#      make web     → arranca la app web en :3000
#      make dev     → engine + voice + web juntos (Ctrl+C mata todos)

PORT ?= 3000
ENGINE_DIR := engine/ACE-Step-1.5
ENGINE_REPO := https://github.com/ACE-Step/ACE-Step-1.5.git
VOICE_DIR := engine/voice
SEEDVC_REPO := https://github.com/Plachtaa/seed-vc.git
APOLLO_REPO := https://github.com/JusperLee/Apollo.git

.DEFAULT_GOAL := help
.PHONY: help setup setup-engine setup-voice setup-web engine voice web dev check clean-audio video

## help: lista de targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'

## setup: instala motor, servicio de voz y web
setup: setup-engine setup-voice setup-web

## setup-engine: clona ACE-Step 1.5 y crea su entorno Python con uv
setup-engine: $(ENGINE_DIR)/.venv engine/.env

$(ENGINE_DIR):
	git clone --depth 1 $(ENGINE_REPO) $(ENGINE_DIR)

$(ENGINE_DIR)/.venv: | $(ENGINE_DIR)
	cd $(ENGINE_DIR) && uv sync

engine/.env: engine/.env.example
	cp engine/.env.example engine/.env

## setup-voice: clona Seed-VC y Apollo y crea el entorno Python (3.10) del servicio de voz
setup-voice: $(VOICE_DIR)/.venv/bin/python

$(VOICE_DIR)/seed-vc:
	git clone --depth 1 $(SEEDVC_REPO) $(VOICE_DIR)/seed-vc

$(VOICE_DIR)/Apollo:
	git clone --depth 1 $(APOLLO_REPO) $(VOICE_DIR)/Apollo

$(VOICE_DIR)/.venv/bin/python: $(VOICE_DIR)/requirements.txt | $(VOICE_DIR)/seed-vc $(VOICE_DIR)/Apollo
	cd $(VOICE_DIR) && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -r requirements.txt
	@touch $(VOICE_DIR)/.venv/bin/python

## setup-web: instala dependencias de la app web
setup-web: web/node_modules web/.env.local

web/node_modules: web/package.json web/pnpm-lock.yaml
	cd web && pnpm install
	@touch web/node_modules

web/.env.local: web/.env.example
	cp web/.env.example web/.env.local

## engine: arranca la API de ACE-Step (http://127.0.0.1:8001)
engine: setup-engine
	./engine/run.sh

## voice: arranca el servicio de conversión de voz (http://127.0.0.1:8002)
voice: setup-voice
	./$(VOICE_DIR)/run.sh

## video: arranca el servicio de video de imágenes (http://127.0.0.1:8003), necesita engine/video/.venv
video:
	./engine/video/stills/run.sh

## web: arranca la app web (http://localhost:$(PORT))
web: setup-web
	cd web && PORT=$(PORT) pnpm dev

## dev: arranca motor, voz y web a la vez
dev: setup
	@trap 'kill 0' INT TERM; \
	./engine/run.sh & \
	./$(VOICE_DIR)/run.sh & \
	(cd web && PORT=$(PORT) pnpm dev) & \
	wait

## check: typecheck + lint de la web
check: setup-web
	cd web && pnpm typecheck && pnpm lint

## clean-audio: borra canciones generadas y la base de datos local
clean-audio:
	rm -rf web/data/audio web/data/voices web/data/suno.db* $(VOICE_DIR)/.cache/jobs
