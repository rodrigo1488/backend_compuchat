#!/usr/bin/env bash
# Deploy do Compuchat na VPS. Rode na pasta do backend: ./up.sh
# O frontend entra junto quando existe em ../frontend (ou em FRONTEND_DIR).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-"$ROOT/../frontend"}"
PM2_APP="${PM2_APP:-compumais-backend}"

cd "$ROOT"
echo "==> Backend: git pull"
git pull --ff-only

echo "==> Backend: dependências"
npm install

echo "==> Backend: build"
npm run build

echo "==> Backend: migrations"
npx sequelize db:migrate

echo "==> Backend: pm2 restart $PM2_APP"
pm2 restart "$PM2_APP"

if [[ -f "$FRONTEND_DIR/package.json" ]]; then
  cd "$FRONTEND_DIR"
  echo "==> Frontend: git pull"
  git pull --ff-only
  echo "==> Frontend: dependências"
  npm install
  echo "==> Frontend: build sem derrubar o site"
  npm run build:live
else
  echo "==> Frontend não encontrado em $FRONTEND_DIR. Só o backend foi atualizado."
fi

echo "==> Deploy concluído."
