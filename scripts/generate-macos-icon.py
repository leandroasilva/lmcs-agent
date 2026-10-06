#!/usr/bin/env python3
"""
Gera o ícone macOS (ICNS) a partir do design do logo LMCS.
"""

from PIL import Image, ImageDraw
import os
import subprocess

# Dimensões do ícone
ICON_SIZE = 1024
SCALE = ICON_SIZE / 128  # Fator de escala do SVG original (128x128)

def create_icon():
    # Criar imagem com fundo transparente
    img = Image.new('RGBA', (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Fundo: retângulo arredondado #101A2E
    # rx=28 no SVG original = 28*8 = 224 pixels
    corner_radius = int(28 * SCALE)
    draw.rounded_rectangle(
        [0, 0, ICON_SIZE-1, ICON_SIZE-1],
        radius=corner_radius,
        fill='#101A2E'
    )
    
    # Path 1: Forma em L verde #5EF4D6
    # M22 32H36V82H60V96H22Z
    points_p1 = [
        (22 * SCALE, 32 * SCALE),  # M22 32
        (36 * SCALE, 32 * SCALE),  # H36
        (36 * SCALE, 82 * SCALE),  # V82
        (60 * SCALE, 82 * SCALE),  # H60
        (60 * SCALE, 96 * SCALE),  # V96
        (22 * SCALE, 96 * SCALE),  # H22
    ]
    draw.polygon(points_p1, fill='#5EF4D6')
    
    # Path 2: Seta azul #B6C3FF
    # M74 32L106 64L74 96L64 85L85 64L64 43Z
    points_p2 = [
        (74 * SCALE, 32 * SCALE),   # M74 32
        (106 * SCALE, 64 * SCALE),  # L106 64
        (74 * SCALE, 96 * SCALE),   # L74 96
        (64 * SCALE, 85 * SCALE),   # L64 85
        (85 * SCALE, 64 * SCALE),   # L85 64
        (64 * SCALE, 43 * SCALE),   # L64 43
    ]
    draw.polygon(points_p2, fill='#B6C3FF')
    
    return img

def create_iconset(img):
    """Cria o diretório iconset com todos os tamanhos necessários."""
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    iconset_dir = os.path.join(project_root, 'assets', 'prod', 'icon.iconset')
    
    # Criar diretório
    os.makedirs(iconset_dir, exist_ok=True)
    
    # Tamanhos necessários para macOS
    sizes = [16, 32, 64, 128, 256, 512]
    
    for size in sizes:
        # Tamanho normal
        resized = img.resize((size, size), Image.LANCZOS)
        resized.save(os.path.join(iconset_dir, f'icon_{size}x{size}.png'))
        
        # Tamanho @2x (Retina)
        resized_2x = img.resize((size * 2, size * 2), Image.LANCZOS)
        resized_2x.save(os.path.join(iconset_dir, f'icon_{size}x{size}@2x.png'))
    
    return iconset_dir

def convert_to_icns(iconset_dir):
    """Converte iconset para ICNS usando iconutil."""
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icns_file = os.path.join(project_root, 'assets', 'prod', 'icon.icns')
    
    try:
        subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', icns_file], check=True)
        print(f'Ícone ICNS gerado com sucesso: {icns_file}')
        return icns_file
    except subprocess.CalledProcessError as e:
        print(f'Erro ao converter para ICNS: {e}')
        print('Certifique-se de que está rodando no macOS')
        return None

def main():
    print('Gerando ícone macOS para LMCS Code...')
    
    # Criar ícone em alta resolução
    img = create_icon()
    
    # Salvar PNG de alta resolução para referência
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    png_file = os.path.join(project_root, 'assets', 'prod', 'icon-1024.png')
    img.save(png_file)
    print(f'PNG de alta resolução salvo: {png_file}')
    
    # Criar iconset
    iconset_dir = create_iconset(img)
    print(f'Iconset criado: {iconset_dir}')
    
    # Converter para ICNS
    icns_file = convert_to_icns(iconset_dir)
    
    # Limpar iconset
    if os.path.exists(iconset_dir):
        import shutil
        shutil.rmtree(iconset_dir)
        print('Iconset temporário removido')
    
    if icns_file:
        print('\n✓ Concluído! O ícone está pronto para uso no electron-builder')
    else:
        print('\n✗ Falha ao gerar ICNS. Verifique se está no macOS.')

if __name__ == '__main__':
    main()
