#!/usr/bin/env python3
"""Local Emscripten 4.0.11 build; no compiler download or cloud execution."""
from pathlib import Path
import argparse, datetime, hashlib, json, subprocess
root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--emcc', required=True)
args = parser.parse_args()
compiler = Path(args.emcc).resolve()
version = subprocess.check_output([str(compiler), '--version'], text=True).splitlines()[0]
if '4.0.11' not in version:
    raise SystemExit('Use pinned Emscripten 4.0.11')
sources = ['libeot.c','EOT.c','writeFontFile.c','triplet_encodings.c','ctf/parseCTF.c','ctf/parseTTF.c','ctf/SFNTContainer.c','util/stream.c','lzcomp/ahuff.c','lzcomp/bitio.c','lzcomp/liblzcomp.c','lzcomp/lzcomp.c','lzcomp/mtxmem.c']
inputs = ['source/libeot/src/' + name for name in sources] + ['source/eot-adapter.c']
command = [str(compiler), '-O2','-std=c99','-DDECOMPRESS_ON','-Isource/libeot/inc', *inputs,'--no-entry','-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=worker,node','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=16777216','-sMAXIMUM_MEMORY=134217728','-sABORTING_MALLOC=0','-sSTACK_SIZE=1048576','-sEXPORTED_FUNCTIONS=["_sb_decode_eot","_sb_free","_malloc","_free"]','-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPU32"]','-o','eot-decoder.mjs']
subprocess.run(command, cwd=root, check=True)
sha = lambda p: hashlib.sha256((root / p).read_bytes()).hexdigest()
receipt = {'scope':'Document EOT decoder only; MPL-2.0 source supplied. No customer font bytes. Disposable caller-owned worker,128MiB decoder linear-memory ceiling,32MiB input/output face bounds. Native FreeType remains the admitted engine and has a separate allocation contract.', 'builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'compilerVersion':version, 'command':['emcc', *command[1:]], 'inputs':[{'file':p,'sha256':sha(p)} for p in inputs], 'artifacts':[{'file':p,'sha256':sha(p),'size':(root/p).stat().st_size} for p in ['eot-decoder.mjs','eot-decoder.wasm']]}
(root/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt['artifacts']))
