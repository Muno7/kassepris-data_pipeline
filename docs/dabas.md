# Dabas enrichment and product images

Dabas is an optional enrichment source for product records already observed by
Kassepris. It is **not** the source of truth for whether a retailer sells a
product, its price, availability, or its retailer-specific product metadata.
Those remain the responsibility of the Coop, ICA, and Willys feeds.

## Configuration

Set `DABAS_API_KEY` in a local environment file. Never put its value in source,
documentation, test output, or commits.

## GTIN lookup

Kassepris stores a canonical GTIN as an EAN-13 for ordinary consumer products.
Dabas's article endpoint expects the GTIN-14 representation, so pad the stored
value to 14 digits for the request:

```text
GET /DABASService/V2/article/gtin/{gtin14}/JSON?apikey=...
```

For example, stored GTIN `7311311015168` must be sent as
`07311311015168`. Compare the returned `GTIN` after canonical normalization,
not as a raw string, because Dabas returns GTIN-14.

A Dabas `404` means that the article is not published in Dabas. It is not proof
that Kassepris's GTIN is wrong. The hierarchy, versions, and free-text search
endpoints do not provide a fallback for a GTIN absent from Dabas. `ARIDENT`,
`ULIDENT`, and `GLN` endpoints require distinct supplier identifiers that the
retailer feeds do not provide.

## Coverage observed on 2026-09-16

A stable, catalogue-spread sample of 125 non-restricted GTIN products from the
configured database produced:

| Result | Count |
| --- | ---: |
| Found in Dabas with the same canonical GTIN | 26 |
| Not found in Dabas | 99 |
| Found articles with a usable base product image | 22 |

The misses included non-food products (such as clothing and appliances) and
some food products. Dabas is therefore useful for opportunistic enrichment,
not complete catalogue replacement.

## Using Dabas images

An article response can contain `Bilder`, an array of media entries. Select only
the entry whose `Informationstyp` is `PRODUCT_IMAGE` and use its `Lank` as the
product image URL. Do not construct Azure Blob URLs from a GTIN.

The returned URL is a public, supplier-published Dabas image URL. Render it
directly in the client (for example, with an ordinary `<img>`); do not download
or host image binaries solely to create an application URL. Some valid PNGs
currently report `application/octet-stream`, so image validation should inspect
the image response or allow the browser to decode it rather than reject it only
by the response MIME type.

Dabas's Webservice terms permit free use of published supplier article
information but require attribution to Dabas when publishing that information.
These images are supplier-published API assets, not public-domain or
open-source images. Preserve an appropriate Dabas attribution in any UI that
uses them. Recheck the terms before rehosting images or using them beyond the
API integration.

## Future implementation policy

1. Look up Dabas only for a valid, non-restricted GTIN.
2. Accept Dabas metadata/images only when the returned canonical GTIN matches
   the local product's canonical GTIN.
3. Prefer the Dabas `PRODUCT_IMAGE` URL when present and usable; otherwise keep
   the existing retailer image URL as fallback.
4. Keep image provenance before replacing the existing `image_url`; a later
   schema change should make the source explicit rather than silently replacing
   retailer data.
5. Refresh Dabas URLs during a future enrichment job, since suppliers can
   replace their published media.

## Diagnostic test

The test is read-only against the database selected by `DB_URL` and makes live
Dabas requests. It does not reset the schema or persist image files:

```bash
DABAS_TEST_SAMPLE_SIZE=125 npm run test:dabas
```

It intentionally fails when a sampled GTIN is absent from Dabas, making
coverage gaps visible. It reports matched GTINs, Dabas image URLs, image
signature checks, and category summaries. The default sample size is 5; the
supported range is 1–250.

## Primary sources

- [Dabas Webservice API specification](https://api.dabas.com/swagger/v1/swagger.json)
- [Dabas media-file documentation](https://kundservice.dabas.com/knowledge-base/dabas-manual-ix-dabas-mediafiler/)
- [Dabas Webservice terms](https://dabas.blob.core.windows.net/dabas-public/Allma%CC%88nna%20villkor%20DABAS%20-%20Dabas%20webservice%20API.pdf)
