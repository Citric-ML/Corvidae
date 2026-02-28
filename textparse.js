let connectionMode = null; // stores idea id currently waiting to connect
let ideaCounter = 0; // unique ids
let connections = []; // list of connections
let pendingSource = null; //
let connectModeActive = false; //edits styling to signify connect mode

/*
keep adding onto STOPWORDS as you test Corvidaes
*/
//words that won't be factored in for suggestions
const STOPWORDS = new Set([
    "the","and","of","to","in","a","is","that","for","on","with",
    "as","by","at","from","an","be","this","which","or","it",
    "are","was","were","has","had","have","but","not","their",
    "its","they","them","he","she","his","her","also", "less",
    "more", "north", "south", "east", "west", "along", "there",
    "into", "around", "first", "last", "bottom", "top"
]);

/*---------------------------
Helpers come first, as always
*/
function getIdeas() {
    const items = document.querySelectorAll(".idea-item");

    const ideas = [];

    items.forEach(item => {
        const name = item.querySelector(".idea-name").value.trim();
        const group = item.getCommittedGroup ? item.getCommittedGroup(): "no group";

        if (name) {
            ideas.push({
                name,
                group: group || "no group"
            });
        }
    });

    return ideas;
}
//---------------------------
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

/*
Modal Logic
*/
let modalSource = null;
let modalTarget = null;

function openConnectionModal(sourceName, targetName) {
    modalSource = sourceName;
    modalTarget = targetName;

    const modal = document.getElementById("connectionModal");
    const title = document.getElementById("modalTitle");

    title.textContent = `How does "${sourceName}" influence "${targetName}"?`;

    document.querySelector('input[value="forward"]').checked = true;
    document.getElementById("relationshipInput").value = "";

    modal.style.display = "flex";
}

document.getElementById("saveConnectionBtn")
.addEventListener("click", () => {

    const direction = document.querySelector('input[name="direction"]:checked').value;
    const label = document.getElementById("relationshipInput").value.trim();

    if (!label) return;

    connections.push({
        from: modalSource,
        to: modalTarget,
        label: label,
        bidirectional: direction === "bidirectional"
    });

    closeModal();
    exitConnectMode();
    renderConnections();

});

function closeModal() {
    document.getElementById("connectionModal").style.display = "none";
}

/*
Main idea listing section
how connections work:
client clicks "connect" button
client clicks another "connect" button
the two idea objects are listed in eachothers connection list
if one is removed both are, completely symmetrical system
*/
function handleConnectClick(wrapper) {
    const ideaName = wrapper.dataset.ideaName;
    if (!ideaName) return;

    // Clicking same button cancels mode
    if (pendingSource === wrapper) {
        exitConnectMode();
        return;
    }

    if (!connectModeActive) {
        enterConnectMode(wrapper);
    } else {
        const targetName = ideaName;
        const sourceName = pendingSource.dataset.ideaName;

        openConnectionModal(sourceName, targetName);
    }
}

function enterConnectMode(wrapper) {
    pendingSource = wrapper;
    connectModeActive = true;

    document.querySelectorAll(".connect-btn").forEach(btn => {
        if (btn.parentElement !== wrapper) {
            btn.classList.add("gray");
        }
    });
}

function exitConnectMode() {
    pendingSource = null;
    connectModeActive = false;

    document.querySelectorAll(".connect-btn").forEach(btn => {
        btn.classList.remove("gray");
    });
}
//create/remove connections
function createConnection(ideaA, ideaB) {
    const idA = ideaA.dataset.id;
    const idB = ideaB.dataset.id;

    if (ideaA.connections.has(idB)) return;

    ideaA.connections.add(idB);
    ideaB.connections.add(idA);

    renderConnections(ideaA);
    renderConnections(ideaB);
}

function removeConnection(ideaA, ideaB) {
    ideaA.connections.delete(ideaB.dataset.id);
    ideaB.connections.delete(ideaA.dataset.id);

    renderConnections(ideaA);
    renderConnections(ideaB);
}
function renderConnections(idea) {
    const list = idea.querySelector(".connection-list");
    list.innerHTML = "";

    idea.connections.forEach(id => {
        const target = document.querySelector(
            `.idea-item[data-id="${id}"]`
        );

        const targetName =
            target.querySelector(".idea-name").value || "Unnamed";

        const item = document.createElement("div");
        item.classList.add("connection-item");

        const label = document.createElement("span");
        label.textContent = targetName;

        const remove = document.createElement("span");
        remove.textContent = " ✕";
        remove.classList.add("remove-connection");

        remove.addEventListener("click", () => {
            removeConnection(idea, target);
        });

        item.appendChild(label);
        item.appendChild(remove);

        list.appendChild(item);
    });
}


/*
Suggestions
*/

//getting most used words in text
function extractKeywordSuggestions(data) {
    const wordCounts = {};

    data.sections.forEach(section => {
        const text = section.paragraph.toLowerCase();

        const words = text.match(/\b[a-z]{4,}\b/g); // 4+ letter words only
        if (!words) return;

        words.forEach(word => {
            if (!STOPWORDS.has(word)) {
                wordCounts[word] = (wordCounts[word] || 0) + 1;
            }
        });
    });

    return Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(entry => entry[0]);
}
function renderSuggestions(keywords) {
    const container = document.getElementById("suggestions");
    container.innerHTML = "";

    keywords.forEach(word => {
        const chip = document.createElement("div");
        chip.classList.add("suggestion-chip");
        chip.textContent = word;

        chip.addEventListener("click", () => {
            addIdea(word);
        });

        container.appendChild(chip);
    });
}
/*
Visualizes topic map user creates
*/

const colors = [
    "#FFB3BA",
    "#FFDFBA",
    "#BAFFC9",
    "#C7ECFF",
    "#C3B1E1"

];

const groupColors = {};

function getGroupColor(groupName) {
    if (!groupColors[groupName]) {
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        groupColors[groupName] = randomColor;
    }
    return groupColors[groupName];
}

function renderGraph() {
    const graphContainer = document.getElementById("graphContainer");
    graphContainer.innerHTML = "";

    const ideas = getIdeas();

    const grouped = {};

    ideas.forEach(idea => {
        const group = idea.group || "no group";

        if (!grouped[group]) {
            grouped[group] = [];
        }

        grouped[group].push(idea.name);
    });

    for (const groupName in grouped) {
        const groupBox = document.createElement("div");
        groupBox.classList.add("group-box");

        const color = getGroupColor(groupName);
        groupBox.style.backgroundColor = color;

        const title = document.createElement("div");
        title.classList.add("group-title");
        title.textContent = groupName;

        groupBox.appendChild(title);

        grouped[groupName].forEach(ideaName => {
            const node = document.createElement("div");
            node.classList.add("idea-node");
            node.textContent = ideaName;
            groupBox.appendChild(node);
        });

        graphContainer.appendChild(groupBox);
    }
}

function addIdea(value = "", group = "no group") {
    const ideaList = document.getElementById("ideaList");

    const id = ideaCounter++;

    const wrapper = document.createElement("div");
    wrapper.classList.add("idea-item");
    wrapper.dataset.id = id;

    wrapper.connections = new Set();

    // IDEA NAME
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = "Enter main idea...";
    input.classList.add("idea-name");
    input.addEventListener("input", () => {
        wrapper.dataset.ideaName = input.value.trim();
    });

    // GROUP LABEL
    const groupLabel = document.createElement("div");
    groupLabel.textContent = "Group:";
    groupLabel.classList.add("group-label");
    const groupInput = document.createElement("input");
    groupInput.type = "text";
    groupInput.value = group;
    groupInput.classList.add("group-input");
    let committedGroup = group || "no group";

    // SAVE BUTTON (hidden initially)
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.classList.add("group-save-btn");
    saveBtn.style.display = "none";

    // When user starts typing show Save button
    groupInput.addEventListener("input", () => {
        if (groupInput.value.trim() !== committedGroup) {
            saveBtn.style.display = "inline-block";
        } else {
            saveBtn.style.display = "none";
        }
    });

    // Save commits change
    saveBtn.addEventListener("click", () => {
        const newValue = groupInput.value.trim() || "no group";

        committedGroup = newValue;
        groupInput.value = newValue;

        saveBtn.style.display = "none";

        renderGraph(); // only update here
    });

    // Fallback on blur
    groupInput.addEventListener("blur", () => {
        if (!groupInput.value.trim()) {
            groupInput.value = committedGroup;
        }
    });

    // CONNECT BUTTON
    const connectBtn = document.createElement("button");
    connectBtn.textContent = "Connect";
    connectBtn.classList.add("connect-btn");

    wrapper.dataset.ideaName = value; // keep updated later

    connectBtn.addEventListener("click", () => {
        handleConnectClick(wrapper);
    });

    wrapper.appendChild(connectBtn);
    // COLLAPSIBLE CONNECTIONS
    const toggleConnections = document.createElement("div");
    toggleConnections.textContent = "Connections";
    const connectionList = document.createElement("div");
    connectionList.classList.add("connection-list");

    wrapper.getCommittedGroup = () => committedGroup;
    wrapper.appendChild(input);
    wrapper.appendChild(groupLabel);
    wrapper.appendChild(groupInput);
    wrapper.appendChild(connectBtn);
    wrapper.appendChild(toggleConnections);
    wrapper.appendChild(connectionList);
    wrapper.appendChild(saveBtn);

    ideaList.appendChild(wrapper);

    input.addEventListener("input", renderGraph);
    groupInput.addEventListener("input", renderGraph);
}

document.getElementById("addIdeaBtn").addEventListener("click", () => {
    addIdea();
    renderGraph();
});
/*
Glue code
*/
function renderPage(data) {
    const output = document.getElementById("output");
    output.innerHTML = "";

    data.sections.forEach(section => {
        const sectionDiv = renderSection(section);
        output.appendChild(sectionDiv);
    });
    const keywords = extractKeywordSuggestions(data);
    renderSuggestions(keywords);
    renderGraph()
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
