const API_URL = "https://en.wikipedia.org/w/api.php";
/*
Fetches the article
*/
async function fetchWikitext(title) {
    const params = new URLSearchParams({
        action: "query",
        format: "json",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        titles: title,
        formatversion: "2",
        origin: "*"  // Required for CORS
    });

    const response = await fetch(`${API_URL}?${params}`);
    const data = await response.json();

    const pages = data.query.pages;

    if (!pages[0].revisions) {
        throw new Error("Page not found or no revisions.");
    }

    return pages[0].revisions[0].slots.main.content;
}
/*
Takes the given data and parses specific sections
*/
function parseSections(wikitext) {
    const sectionRegex = /^==+\s*(.*?)\s*==+$/gm;

    let sections = [];
    let match;
    let lastIndex = 0;
    let lastTitle = "Lead";

    while ((match = sectionRegex.exec(wikitext)) !== null) {
        const content = wikitext.slice(lastIndex, match.index).trim();
        sections.push({
            title: lastTitle,
            content: content
        });

        lastTitle = match[1];
        lastIndex = sectionRegex.lastIndex;
    }

    // Push final section
    sections.push({
        title: lastTitle,
        content: wikitext.slice(lastIndex).trim()
    });

    return sections;
}

function getFirstParagraph(sectionText) {
    const paragraphs = sectionText
        .split("\n\n")
        .map(p => p.trim())
        .filter(p => p.length > 0);

    return paragraphs[0] || "";
}

function getCitationSentence(sectionText) {
    const sentences = sectionText.split(/(?<=[.!?])\s+/);

    for (let sentence of sentences) {
        if (sentence.includes("<ref")) {
            return sentence.trim();
        }
    }

    return null;
}

function extractLinks(wikitext) {
    const linkRegex = /\[\[(.*?)\]\]/g;
    const links = new Set();
    let match;

    while ((match = linkRegex.exec(wikitext)) !== null) {
        let title = match[1].split("|")[0];

        if (!title.toLowerCase().startsWith("file:")
            && !title.toLowerCase().startsWith("image:")
            && !title.toLowerCase().startsWith("category:")) {

            links.add(title);
        }
    }

    return Array.from(links).sort();
}

async function parsePage(title) {
    const wikitext = await fetchWikitext(title);

    const sections = parseSections(wikitext);
    const topics = extractLinks(wikitext);

    const structuredSections = sections.map(section => ({
        section: section.title,
        first_paragraph: getFirstParagraph(section.content),
        citation_sentence: getCitationSentence(section.content)
    }));

    return {
        title: title,
        sections: structuredSections,
        topics: topics
    };
}
/*
After the parsing process, metadata still needs to be stripped and everything needs to be cleaned up.
The next section does so, before displaying them in <div>s
Essentially, the cleanup crew for raw data
*/
function removeTemplates(text) {
    let result = "";
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" && text[i+1] === "{") {
            depth++;
            i++;
        } else if (text[i] === "}" && text[i+1] === "}") {
            depth--;
            i++;
        } else if (depth === 0) {
            result += text[i];
        }
    }

    return result;
}
function cleanWikiMarkup(text) {
    // Remove bold/italic
    text = text.replace(/'''/g, "").replace(/''/g, "");

    // Convert [[Page|Display]] → Display
    text = text.replace(/\[\[(.*?)\|(.*?)\]\]/g, "$2");

    // Convert [[Page]] → Page
    text = text.replace(/\[\[(.*?)\]\]/g, "$1");

    return text;
}
function extractReferences(text) {
    const refRegex = /<ref[^>]*>(.*?)<\/ref>/gs;

    let refs = [];
    let match;

    while ((match = refRegex.exec(text)) !== null) {
        refs.push(match[1].trim());
    }

    // Remove references from text
    const cleanedText = text.replace(refRegex, "");

    return {
        cleanedText,
        references: refs
    };
}
function processParagraph(rawText) {
    // Step 1: Remove templates
    let text = removeTemplates(rawText);

    // Step 2: Extract references
    const { cleanedText, references } = extractReferences(text);

    // Step 3: Remove wiki formatting
    text = cleanWikiMarkup(cleanedText);

    // Step 4: Clean extra whitespace
    text = text.replace(/\n+/g, " ").trim();

    return {
        paragraph: text,
        references: references
    };
}
/*
This section converts the now cleaned 
data into a series of per-section <div> objects
*/
function renderSection(sectionData) {
    const container = document.createElement("div");
    container.classList.add("section");

    const title = document.createElement("h2");
    title.textContent = sectionData.section;

    const processed = processParagraph(sectionData.first_paragraph);

    const paragraph = document.createElement("p");
    paragraph.textContent = processed.paragraph;

    container.appendChild(title);
    container.appendChild(paragraph);

    // If references exist
    if (processed.references.length > 0) {
        const refList = document.createElement("ul");
        refList.classList.add("references");

        processed.references.forEach(ref => {
            const li = document.createElement("li");
            li.textContent = ref;
            refList.appendChild(li);
        });

        container.appendChild(refList);
    }

    return container;
}
function renderPage(data) {
    const output = document.getElementById("output");
    output.innerHTML = "";

    data.sections.forEach(section => {
        const sectionDiv = renderSection(section);
        output.appendChild(sectionDiv);
    });
}
/*
Final search handler
*/
async function handleSearch() {
    const title = document.getElementById("titleInput").value;

    try {
        const data = await parsePage(title);
        renderPage(data);
    } catch (err) {
        document.getElementById("output").textContent =
            "Error: " + err.message;
    }
}

