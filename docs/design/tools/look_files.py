"""Save or restore the helper's three look files, so a test leaves the owner's choice as it was.
    python look_files.py save <folder>      python look_files.py restore <folder>
Restore puts back what was saved and removes a look file the test created."""
import os
import pathlib
import shutil
import sys

NAMES = ('theme.txt', 'keep-websites-light', 'own-colours.json')
home = pathlib.Path(os.environ['LOCALAPPDATA']) / 'Gamblium'
assert home.name == 'Gamblium' and home.is_dir(), home
what, store = sys.argv[1], pathlib.Path(sys.argv[2])
store.mkdir(parents=True, exist_ok=True)
if what == 'save':
    for old in store.iterdir():
        if old.name in NAMES:
            old.unlink()
    for n in NAMES:
        if (home / n).is_file():
            shutil.copy2(home / n, store / n)
    print('saved:', [n for n in NAMES if (store / n).exists()] or 'none exist')
else:
    for n in NAMES:
        if (store / n).is_file():
            shutil.copy2(store / n, home / n)
        elif (home / n).is_file():
            (home / n).unlink()  # created by the test
    print('now there:', [n for n in NAMES if (home / n).exists()] or 'none')
