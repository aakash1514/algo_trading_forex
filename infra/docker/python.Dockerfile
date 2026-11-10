# syntax=docker/dockerfile:1.7
# A Python service of ForexEdge (ml-service or research-agent):
#   --build-arg APP=ml-service     --build-arg MODULE=ml_service       (port 3006)
#   --build-arg APP=research-agent --build-arg MODULE=research_agent   (port 3007)
#
# Dependencies from the app's Linux lock, hash-checked, without resolving anything (--no-deps): the
# lock is the whole dependency set (tools/python/linux_lock.py derives it from requirements.lock;
# torch is the CPU-only build from PyTorch's index). The app sits at the same path as in the repo
# (/srv/forexedge/apps/<app>) because its config finds the repo root four levels up. No .env in the
# image: settings come from the environment. Runs as the non-root user "app", which can't modify the code.
ARG PYTHON_IMAGE=python:3.12.10-slim-bookworm

FROM ${PYTHON_IMAGE} AS deps
ARG APP
COPY apps/${APP}/requirements.linux.lock /tmp/requirements.linux.lock
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-hashes --no-deps \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -r /tmp/requirements.linux.lock

FROM ${PYTHON_IMAGE} AS runtime
ARG APP
ARG MODULE
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 APP_MODULE=${MODULE}
RUN useradd --system --uid 10001 --no-create-home app
COPY --from=deps /opt/venv /opt/venv
WORKDIR /srv/forexedge/apps/${APP}
# src (and ml-service's models/, research-agent's sql/), owned by root and read-only for "app"; tests,
# scripts and venvs are left out by .dockerignore
COPY apps/${APP}/ ./
USER app
CMD ["sh", "-c", "exec uvicorn ${APP_MODULE}.main:create_app --factory --app-dir src --host 0.0.0.0 --port ${PORT}"]
