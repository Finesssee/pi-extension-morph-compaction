# Pi Extension: morph-compaction

Private source repo for the Pi `morph-compaction` extension.

Repo contents:
- `.pi/extensions/morph-compaction/`
- `templates/morph-compaction.json`

What it adds:
- Morph-first session compaction
- `/compactor`
- fallback to Pi built-in compaction when Morph is unavailable

Runtime dependencies:
- none beyond Pi itself

Install:
```bash
rsync -a .pi/ ~/.pi/
cp -n templates/morph-compaction.json ~/.pi/agent/morph-compaction.json
```

Notes:
- `MORPH_API_KEY` belongs in your local `.env`, not in this repo.
- The template is only the default mode/config file. Runtime compaction state is kept separately under `~/.pi/agent/`.
