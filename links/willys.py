from bs4 import BeautifulSoup
import json

codes = []

with open("willys_sitemap.xml", "r", encoding="utf-8") as f:
    soup = BeautifulSoup(f, "xml")

for loc in soup.find_all("loc"):
    url = loc.text.strip()

    if url.startswith("https://www.willys.se/butik/"):
        code = url.rstrip("/").split("/")[-1]

        if code.isdigit():
            codes.append(code)

# Remove duplicates, keep sorted
codes = sorted(set(codes))

print(f"Found {len(codes)} Willys stores")
for c in codes:
    print(c)

with open("willys_store_codes.json", "w", encoding="utf-8") as f:
    json.dump(
        codes,
        f,
        ensure_ascii=False,
        indent=2
    )