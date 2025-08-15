# Printful Export (LuxPrint)

## Local
```bash
cd tools/printful-export
cp .env.example .env   # puis colle ta clé
npm i
npm run export:eu      # Europe, 300 produits, ZIP
# ou:
npm run export:fr      # France, 300 produits, ZIP
