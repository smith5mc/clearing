# ClearingHouse Demo (Client-Side)

This demo is a client-side simulation of the ClearingHouse settlement cycle.
It visualizes payments, swaps, and DvP orders while showing how multiple
stablecoins and ranked preferences interact during settlement.

## Run Locally

```bash
npm install
npm run dev
```

## Build for GitHub Pages

The Vite `base` is set to `./`, so the build is suitable for GitHub Pages.

```bash
npm run build
```

Upload the contents of `dist/` to your GitHub Pages site.

