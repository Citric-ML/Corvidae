import requests

API_URL = "https://en.wikipedia.org/w/api.php"

def fetch_wikitext(title: str) -> str:
    params = {
        "action": "query",
        "format": "json",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "titles": title,
        "formatversion": "2",
    }

    headers = {
        "User-Agent": "WikiKnowledgeSynth/0.1 (test@example.com)"
    }

    r = requests.get(API_URL, params=params, headers=headers)
    r.raise_for_status()

    pages = r.json()["query"]["pages"]

    if "revisions" not in pages[0]:
        raise ValueError("Page has no revisions (may not exist)")

    return pages[0]["revisions"][0]["slots"]["main"]["content"]
#DO LATER:
#get user inputted title and port it to this python script using JS
#Cat is just a placeholder btw
print(fetch_wikitext("Cat")[:500])
