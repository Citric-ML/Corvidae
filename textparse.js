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
/*
========================================
WIKITEXT NORMALIZATION PIPELINE
========================================
*/
//check for redirects
function checkRedirect(wikitext) {
    const redirectRegex = /^#redirect\s*:?\s*\[\[([^\]]+)\]\]/i;

    const match = wikitext.trim().match(redirectRegex);

    if (match) {
        // Remove possible section anchor (e.g. Page#Section)
        const target = match[1].split("#")[0].trim();
        return target;
    }

    return null;
}
/* Extract and remove all <ref> blocks globally */
function extractAllReferences(text) {
    const refs = [];

    // Full refs
    text = text.replace(/<ref[^>]*>([\s\S]*?)<\/ref>/gi, (_, content) => {
        if (content.trim()) refs.push(content.trim());
        return "";
    });

    // Self-closing refs
    text = text.replace(/<ref[^>]*\/>/gi, "");

    return { text, refs };
}

function extractGalleryImages(text) {
    const galleryRegex = /<gallery[^>]*>([\s\S]*?)<\/gallery>/gi;

    const images = [];
    let match;

    while ((match = galleryRegex.exec(text)) !== null) {
        const galleryContent = match[1];

        const lines = galleryContent
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean);

        lines.forEach(line => {
            // Match: File:Name.jpg|Caption
            const fileMatch = line.match(/^(File|Image):([^|]+)\|?(.*)$/i);

            if (fileMatch) {
                const filename = fileMatch[2].trim();
                const caption = fileMatch[3] ? fileMatch[3].trim() : "";

                images.push({
                    filename,
                    caption
                });
            }
        });
    }

    // Remove entire gallery blocks from text
    const cleanedText = text.replace(galleryRegex, "");

    return {
        text: cleanedText,
        images
    };
}

//Extract media
function extractImages(sectionText) {
    const imageRegex = /\[\[(File|Image):([^|\]]+)(.*?)\]\]/gi;

    const images = [];
    let match;

    while ((match = imageRegex.exec(sectionText)) !== null) {
        const filename = match[2].trim();
        const options = match[3] || "";

        const parts = options.split("|").map(p => p.trim()).filter(Boolean);

        // Remove known formatting keywords
        const ignored = ["thumb", "thumbnail", "right", "left", "center", "frameless"];

        const captionParts = parts.filter(p =>
            !ignored.includes(p.toLowerCase()) &&
            !p.match(/^\d+px$/) &&
            !p.startsWith("alt=")
        );

        const caption = captionParts.length > 0
            ? captionParts[captionParts.length - 1]
            : "";

        images.push({
            filename,
            caption
        });
    }

    // Remove image markup from text
    const cleanedText = sectionText.replace(imageRegex, "");

    return {
        text: cleanedText,
        images
    };
}

/* Remove templates safely */
function removeTemplates(text) {
    let result = "";
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" && text[i+1] === "{") {
            depth++;
            i++;
        } else if (text[i] === "}" && text[i+1] === "}") {
            depth = Math.max(0, depth - 1);
            i++;
        } else if (depth === 0) {
            result += text[i];
        }
    }

    return result;
}

function removeTemplateResidue(text) {
    // Remove convert remnants
    text = text.replace(/\b[Cc]onvert\|[^ ]+/g, "");

    // Remove efn remnants
    text = text.replace(/\befn\b[^ ]*/gi, "");

    // Remove native lang remnants
    text = text.replace(/\bnative lang\|[^ ]+/gi, "");

    // Remove argument-style patterns like |name=... or |t=...
    text = text.replace(/\|\s*[a-zA-Z0-9_-]+\s*=\s*[^| ]+/g, "");

    return text;
}

/* Strict section splitting */
function splitSections(text) {
    const sectionRegex = /^(={2,6})\s*(.*?)\s*\1$/gm;

    const sections = [];
    let lastIndex = 0;
    let lastTitle = "Lead";
    let match;

    while ((match = sectionRegex.exec(text)) !== null) {
        const content = text.slice(lastIndex, match.index).trim();

        sections.push({
            title: lastTitle,
            content
        });

        lastTitle = match[2];
        lastIndex = sectionRegex.lastIndex;
    }

    sections.push({
        title: lastTitle,
        content: text.slice(lastIndex).trim()
    });

    return sections;
}

/* Extract first meaningful paragraph */
function extractFirstParagraph(sectionText) {
    const lines = sectionText.split("\n");

    let paragraph = [];

    for (let line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            if (paragraph.length > 0) break;
            continue;
        }

        // Skip non-prose lines
        if (
            trimmed.startsWith("*") ||
            trimmed.startsWith("|") ||
            trimmed.startsWith("{") ||
            trimmed.startsWith("=") ||
            trimmed.startsWith("[[File:") ||
            trimmed.startsWith("[[Image:")
        ) {
            continue;
        }

        paragraph.push(trimmed);
    }

    return paragraph.join(" ").trim();
}

/* Clean wiki markup */
function cleanMarkup(text) {
    if (!text) return "";

    // Bold / italics
    text = text.replace(/'''+/g, "");
    text = text.replace(/''/g, "");

    // [[Page|Display]]
    text = text.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");

    // [[Page]]
    text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

    // Remove leftover brackets
    text = text.replace(/\[|\]/g, "");

    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();

    return text;
}
async function parsePage(title, redirectDepth = 0) {
    const rawWikitext = await fetchWikitext(title);

    const redirectTarget = checkRedirect(rawWikitext);

    if (redirectTarget) {
        if (redirectDepth > 5) {
            throw new Error("Too many redirects.");
        }

        return await parsePage(redirectTarget, redirectDepth + 1);
    }

    const { text: noRefsText, refs } = extractAllReferences(rawWikitext);

    const cleanedText = removeTemplates(noRefsText);
    const fullyCleanedText = removeTemplateResidue(cleanedText);

    const rawSections = splitSections(fullyCleanedText);

    const skipSections = [
        "References",
        "External links",
        "See also",
        "Further reading",
        "Notes"
    ];

    const structuredSections = rawSections
        .filter(section =>
            !skipSections.includes(section.title)
        )
        .map(section => {
            const { text: noGalleryText, images: galleryImages } =
                extractGalleryImages(section.content);

            const { text: noImagesText, images: inlineImages } =
                extractImages(noGalleryText);

            const allImages = [...galleryImages, ...inlineImages];

            const paragraph = extractFirstParagraph(noImagesText);
            const cleanParagraph = cleanMarkup(paragraph);

            return {
                section: section.title,
                paragraph: cleanParagraph,
                images: allImages
            };
        });

    return {
        title,
        sections: structuredSections,
        references: refs
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
    container.appendChild(title);

    // Render paragraph
    if (sectionData.paragraph) {
        const paragraph = document.createElement("p");
        paragraph.textContent = sectionData.paragraph;
        container.appendChild(paragraph);
    }

    // Render images first
    if (sectionData.images && sectionData.images.length > 0) {
        sectionData.images.forEach(imgData => {
            const figure = document.createElement("figure");

            const img = document.createElement("img");
            img.src = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imgData.filename)}`;
            img.alt = imgData.caption || imgData.filename;
            img.style.maxWidth = "100%";

            const caption = document.createElement("figcaption");
            caption.textContent = cleanMarkup(imgData.caption);

            figure.appendChild(img);
            if (imgData.caption) {
                figure.appendChild(caption);
            }

            container.appendChild(figure);
        });
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

        console.log("PARSE RESULT:", data);

        if (!data || !data.sections) {
            throw new Error("Parse returned invalid structure.");
        }

        renderPage(data);
    } catch (err) {
        document.getElementById("output").textContent =
            "Error: " + err.message;
    }
}
