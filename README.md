# Altair plugin sandbox

This package supplies one isolated activation and a trusted proxy for the existing Altair API 2 registry. The application keeps its catalog, project plugin list, lock, dependency checks and permission review. Browser plugin source runs in a dedicated Worker created inside an opaque sandboxed iframe. A local plugin explicitly trusted by the application continues to use `AltairPluginHost.install()` directly.

From this independent repository, run `npm install` and `npm run check`. `npm pack --dry-run` checks the distribution entries. The main import has no DOM side effects; starting a browser session requires a document with a body, Web Crypto, MessageChannel, blob Workers and sandboxed `srcdoc` frames.

## Reference

The manifest, activation options, session API and limits are in [docs/reference.md](docs/reference.md).


## License

[MPL-2.0](LICENSE).
