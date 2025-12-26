from bs4 import BeautifulSoup
import json

SITEMAP_PATH = "coop_sitemap.xml"
PREFIX = "https://www.coop.se/butiker-erbjudanden/"

def extract_coop_store_links():
    with open(SITEMAP_PATH, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "xml")

    links = []

    for loc in soup.find_all("loc"):
        url = loc.text.strip()
        if url.startswith(PREFIX):
            links.append(url)

    return links


if __name__ == "__main__":
    store_links = extract_coop_store_links()
    print(f"Found {len(store_links)} Coop store links")

with open("coop_store_links.json", "w", encoding="utf-8") as f:
    json.dump(store_links, f, indent=2, ensure_ascii=False)

