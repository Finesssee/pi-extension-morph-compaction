# Pi Extension: morph-compaction

Morph-first session compaction extension for Pi.

What it adds:
- Morph-first session compaction
- `/compactor`
- fallback to Pi built-in compaction when Morph is unavailable
- no footer status token during normal Pi use

## Install

Install directly from GitHub right now:

```bash
pi install https://github.com/Finesssee/pi-extension-morph-compaction
```

After publishing to npm:

```bash
pi install npm:pi-morph-compaction
```

For local development, a local path install also works:

```bash
pi install /absolute/path/to/pi-extension-morph-compaction
```

## Config

`morph-compaction` auto-creates its default config on first use at:

```bash
~/.pi/agent/morph-compaction.json
```

The checked-in template at [templates/morph-compaction.json](/home/fsos/pi-extension-repos/pi-extension-morph-compaction/templates/morph-compaction.json) is now just a reference copy, not a required manual install step.

## Runtime dependencies

- none beyond Pi itself

## Notes

- `MORPH_API_KEY` belongs in your local `.env`, not in this repo.
- Runtime compaction state is kept separately under `~/.pi/agent/morph-compaction-state.json`.
- The package metadata is set up so Pi can discover the extension directly from the published package instead of depending on manual hidden-folder copying.
