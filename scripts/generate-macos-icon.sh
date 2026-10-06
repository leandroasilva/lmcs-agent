#!/bin/bash
# Script para converter SVG em ICNS para macOS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SVG_FILE="$PROJECT_ROOT/assets/prod/logo.svg"
ICONSET_DIR="$PROJECT_ROOT/assets/prod/icon.iconset"
ICNS_FILE="$PROJECT_ROOT/assets/prod/icon.icns"

echo "Gerando ícone macOS a partir de $SVG_FILE"

# Criar diretório iconset
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Converter SVG para PNG em vários tamanhos usando sips (macOS)
# ou ImageMagick se disponível
if command -v sips &> /dev/null; then
  echo "Usando sips (macOS) para conversão..."
  
  # Primeiro converter SVG para PNG temporário grande
  # sips não suporta SVG diretamente, então usamos qlmanage ou rsvg-convert
  if command -v rsvg-convert &> /dev/null; then
    rsvg-convert -w 1024 -h 1024 "$SVG_FILE" > /tmp/icon_1024.png
  elif command -v qlmanage &> /dev/null; then
    qlmanage -t -s 1024 -o /tmp "$SVG_FILE" 2>/dev/null
    mv /tmp/logo.svg.png /tmp/icon_1024.png 2>/dev/null || true
  else
    echo "Erro: rsvg-convert ou qlmanage não encontrado"
    echo "Instale com: brew install librsvg"
    exit 1
  fi
  
  # Gerar tamanhos necessários para iconset
  for size in 16 32 64 128 256 512; do
    sips -z $size $size /tmp/icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}.png"
    sips -z $((size*2)) $((size*2)) /tmp/icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}@2x.png"
  done
  
elif command -v convert &> /dev/null; then
  echo "Usando ImageMagick para conversão..."
  convert -background none -resize 1024x1024 "$SVG_FILE" /tmp/icon_1024.png
  
  for size in 16 32 64 128 256 512; do
    convert -resize ${size}x${size} /tmp/icon_1024.png "$ICONSET_DIR/icon_${size}x${size}.png"
    convert -resize $((size*2))x$((size*2)) /tmp/icon_1024.png "$ICONSET_DIR/icon_${size}x${size}@2x.png"
  done
else
  echo "Erro: sips ou ImageMagick não encontrado"
  echo "No macOS: sips deve estar disponível"
  echo "No Linux: brew install imagemagick ou apt-get install imagemagick"
  exit 1
fi

# Converter iconset para icns
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_FILE"

echo "Ícone gerado com sucesso: $ICNS_FILE"

# Limpar arquivos temporários
rm -rf "$ICONSET_DIR" /tmp/icon_1024.png

echo "Concluído!"
