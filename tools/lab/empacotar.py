#!/usr/bin/env python3
"""FRONT-V1-001 — compacta a PASTA gerada pelo Studio num ZIP de laboratório, como o teste da API monta o pacote real
(PackageInspectorTest.realZip): todos os arquivos regulares, em ordem de caminho, nomes relativos com "/", sem entradas
de diretório, DEFLATE. Os bytes de cada arquivo são copiados como estão (o pacote declara o hash de cada um).

Uso: python tools/lab/empacotar.py <pasta do pacote> <saida.zip> [--stored]

--stored: sem compressão. Mesmo conteúdo (mesma impressão do pacote), outros bytes (outro SHA-256) — para provar que a
publicação recusa um artefato trocado depois da conferência.

O ZIP é só o transporte do ensaio: quem confere o pacote (manifesto, hashes, impressão) é a Platform.
"""
import pathlib
import sys
import zipfile


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--stored"]
    method = zipfile.ZIP_STORED if "--stored" in sys.argv[1:] else zipfile.ZIP_DEFLATED
    if len(args) != 2:
        raise SystemExit("uso: empacotar.py <pasta do pacote> <saida.zip> [--stored]")
    sys.argv[1:3] = args
    src = pathlib.Path(sys.argv[1]).resolve()
    out = pathlib.Path(sys.argv[2]).resolve()
    if not (src / "manifest.json").is_file():
        raise SystemExit(f"{src} não parece um pacote do Studio (manifest.json ausente)")
    if out.is_relative_to(src):
        raise SystemExit("a saída não pode ficar dentro da pasta do pacote")
    files = sorted(p for p in src.rglob("*") if p.is_file() and not p.is_symlink())
    with zipfile.ZipFile(out, "w", compression=method) as z:
        for p in files:
            info = zipfile.ZipInfo(p.relative_to(src).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = method
            z.writestr(info, p.read_bytes())
    print(f"{out} ({len(files)} arquivos)")


if __name__ == "__main__":
    main()
