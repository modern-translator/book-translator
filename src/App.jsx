import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Upload, 
  RefreshCw, 
  Loader2, 
  CheckCircle2, 
  X,
  FileText,
  AlertCircle,
  ChevronRight,
  BookOpen,
  Settings,
  Globe,
  FileDown,
  Sparkles,
  Link as LinkIcon,
  Edit3,
  HelpCircle,
  Languages,
  AlignLeft,
  AlignRight,
  Copy,
  Check,
  Eye,
  SlidersHorizontal,
  RotateCcw
} from 'lucide-react';

// Exponential backoff fetch implementation with timeout and abort handling
const fetchWithRetry = async (url, options, timeoutMs = 60000) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  let lastError;
  
  for (let i = 0; i <= delays.length; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const statusError = new Error(`API Error ${response.status}: ${errorText || response.statusText}`);
        statusError.status = response.status;
        throw statusError;
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      // 429 (quota) and 400/403 (bad key) are handled by the caller's key/model
      // rotation logic, so surface them immediately instead of backing off.
      if (error.status === 429 || error.status === 400 || error.status === 403) {
        throw error;
      }

      // If the request was aborted due to timeout, or it's a 503, we retry
      if (error.name === 'AbortError') {
        console.warn(`Request timed out after ${timeoutMs}ms, retrying... (Attempt ${i + 1})`);
      } else {
        console.warn(`Fetch failed: ${error.message}. Retrying... (Attempt ${i + 1})`);
      }

      if (i < delays.length) {
        await new Promise(resolve => setTimeout(resolve, delays[i]));
      }
    }
  }
  throw lastError;
};

const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const MAX_REQUESTS_PER_KEY_MODEL = 500;
const REQUEST_INTERVAL_MS = 4200;
const TOTAL_API_KEY_SLOTS = 10;

const App = () => {
  // State for File Data and Section Parsing
  const [fileData, setFileData] = useState(null);
  const [parsedSections, setParsedSections] = useState([]);
  const [activeSectionId, setActiveSectionId] = useState(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  
  // Translation & Workflow State
  const [sourceLangMode, setSourceLangMode] = useState('auto'); // 'auto', 'ar_ur', 'en'
  const [isTranslatingAll, setIsTranslatingAll] = useState(false);
  const [progress, setProgress] = useState(0);
  
  // Settings & Customization - API Key
  // Default behavior: the key lives only in sessionStorage (wiped when the tab
  // closes). Persisting it in localStorage is now opt-in via a checkbox in
  // Settings, to reduce how long a raw API key sits in durable browser storage.
  const [apiKeys, setApiKeys] = useState(() => {
    try {
      const raw = sessionStorage.getItem('translator_api_keys') || localStorage.getItem('translator_api_keys');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === TOTAL_API_KEY_SLOTS) return parsed;
      }
    } catch (e) {}
    return Array(TOTAL_API_KEY_SLOTS).fill("");
  });
  const [rememberApiKey, setRememberApiKey] = useState(() => !!localStorage.getItem('translator_api_keys'));
  const [showSettings, setShowSettings] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  // UI Toast Notifications
  const [errorMsg, setErrorMsg] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const pdfDocRef = useRef(null);
  const rotationRef = useRef({ keyIdx: 0, modelIdx: 0, count: 0, deadKeys: new Set() });
  const throttleRef = useRef(Promise.resolve());
  const lastRequestTimeRef = useRef(0);
  const hasRestoredSession = useRef(false);
  const SESSION_STORAGE_KEY = 'translator_session_v1';

  // Restore any previous in-progress session on mount, so closing the tab or
  // an accidental reload doesn't wipe out extraction/translation progress.
  // Note: the live PDF.js document handle itself can't be serialized, so after
  // a restore, per-page source-image re-extraction simply degrades to
  // text-only OCR input (already handled gracefully elsewhere).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.parsedSections) && parsed.parsedSections.length > 0) {
          setFileData(parsed.fileData || null);
          setParsedSections(parsed.parsedSections);
          setActiveSectionId(parsed.activeSectionId ?? parsed.parsedSections[0].id);
          setSourceLangMode(parsed.sourceLangMode || 'auto');
          setSuccessMsg("Restored your previous in-progress session.");
        }
      }
    } catch (e) {
      console.warn("Could not restore previous session:", e);
    } finally {
      hasRestoredSession.current = true;
    }
  }, []);

  // Persist progress after each change so work survives reloads/crashes.
  useEffect(() => {
    if (!hasRestoredSession.current) return; // avoid stomping storage before the restore attempt above runs
    try {
      if (parsedSections.length > 0) {
        const payload = JSON.stringify({ fileData, parsedSections, activeSectionId, sourceLangMode });
        localStorage.setItem(SESSION_STORAGE_KEY, payload);
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch (e) {
      // Likely a storage quota issue on very large books with embedded diagram
      // images - degrade gracefully rather than throwing.
      console.warn("Could not persist session (storage quota likely exceeded):", e);
    }
  }, [fileData, parsedSections, activeSectionId, sourceLangMode]);

  useEffect(() => {
    // Inject Tailwind CSS engine
    const twScript = document.createElement('script');
    twScript.src = 'https://cdn.tailwindcss.com';
    document.head.appendChild(twScript);

    // Inject Custom Fonts (Kalpurush for Bangla, Scheherazade New for Arabic/Urdu, Plus Jakarta Sans for English)
    const styleBlock = document.createElement('style');
    styleBlock.type = 'text/tailwindcss';
    styleBlock.innerHTML = `
        @import "tailwindcss";
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');
        @import url('https://fonts.maateen.me/kalpurush/font.css');
        @import url('https://fonts.googleapis.com/css2?family=Scheherazade+New:wght@400;600;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;600;700&display=swap');

        @theme {
          --font-bangla: "Kalpurush", sans-serif;
          --font-arabic-urdu: "Scheherazade New", "Noto Naskh Arabic", serif;
          --font-sans: "Plus Jakarta Sans", sans-serif;
        }

        body { 
          @apply bg-slate-50 text-slate-900 font-sans antialiased; 
        }
        
        .bangla-font { 
          font-family: "Kalpurush", sans-serif !important; 
        }

        .arabic-urdu-font {
          font-family: "Scheherazade New", "Noto Naskh Arabic", serif !important;
        }

        .english-font {
          font-family: "Plus Jakarta Sans", sans-serif !important;
        }
        
        .mirror-flow { 
          @apply leading-relaxed tracking-normal bg-white p-6 md:p-8 rounded-xl border border-slate-100 transition-all; 
        }

        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          @apply bg-transparent;
        }
        ::-webkit-scrollbar-thumb {
          @apply bg-slate-200 rounded-full hover:bg-slate-300;
        }
    `;
    document.head.appendChild(styleBlock);

    // Load PDF.js library for offscreen image/page rendering
    const pdfScript = document.createElement('script');
    pdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
    pdfScript.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    };
    document.head.appendChild(pdfScript);

    // Load DOMPurify for sanitizing any HTML (LLM-generated or otherwise) before
    // it is ever injected via dangerouslySetInnerHTML (fixes XSS exposure)
    const purifyScript = document.createElement('script');
    purifyScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js';
    document.head.appendChild(purifyScript);

    return () => {
      [twScript, styleBlock, pdfScript, purifyScript].forEach(el => el?.remove());
    };
  }, []);

  // Safe-sanitize helper: falls back to escaping-only behavior if DOMPurify
  // hasn't finished loading yet, so the app never renders raw untrusted HTML.
  const sanitizeHtml = useCallback((html) => {
    if (!html) return html;
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(html, {
        ADD_TAGS: ['input'],
        ADD_ATTR: ['class', 'accept', 'type']
      });
    }
    // DOMPurify not yet loaded: strip script/style tags and on* handlers as a minimal guard
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/ on[a-z]+="[^"]*"/gi, '')
      .replace(/ on[a-z]+='[^']*'/gi, '');
  }, []);

  useEffect(() => {
    const handleFileSelect = (e) => {
      if (e.target && e.target.classList.contains('diagram-upload-input')) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64 = event.target.result;
          const liveContainer = e.target.closest('.diagram-placeholder');
          const editorDiv = e.target.closest('[id^="editor-"]') || e.target.closest('[id^="bangla-view-"]');

          if (liveContainer && editorDiv) {
            // IMPORTANT: never mutate the live React-rendered DOM node directly
            // (that desyncs React's virtual DOM from reality). Instead, operate
            // on a detached clone to compute the new HTML string, and let the
            // subsequent state update (via dangerouslySetInnerHTML) be the ONLY
            // thing that touches the live DOM.
            const detachedRoot = editorDiv.cloneNode(true);
            const detachedContainer = detachedRoot.querySelector('.diagram-placeholder') || detachedRoot;
            detachedContainer.innerHTML = `<img src="${base64}" style="max-width: 100%; max-height: 400px; border-radius: 8px; display: block; margin: 0 auto; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);" alt="Uploaded Diagram" />`;
            detachedContainer.style.border = 'none';
            detachedContainer.style.background = 'transparent';
            detachedContainer.style.padding = '0';

            const isSource = editorDiv.id.startsWith('editor-');
            const pageIdStr = isSource ? editorDiv.id.replace('editor-', '') : editorDiv.id.replace('bangla-view-', '');
            const pageId = parseInt(pageIdStr, 10);

            const customEvent = new CustomEvent('diagramUploaded', {
              detail: { pageId, newHtml: detachedRoot.innerHTML, isSource }
            });
            document.dispatchEvent(customEvent);
          }
        };
        reader.readAsDataURL(file);
      }
    };
    
    const handleDiagramStateUpdate = (e) => {
      const { pageId, newHtml, isSource } = e.detail;
      setParsedSections(prev => prev.map(s => {
        if (s.id === pageId) {
          return isSource ? { ...s, sourceHtml: newHtml } : { ...s, banglaHtml: newHtml };
        }
        return s;
      }));
    };

    document.addEventListener('change', handleFileSelect);
    document.addEventListener('diagramUploaded', handleDiagramStateUpdate);
    
    return () => {
      document.removeEventListener('change', handleFileSelect);
      document.removeEventListener('diagramUploaded', handleDiagramStateUpdate);
    };
  }, []);

  const extractPageImageBase64 = async (pageId) => {
    if (!pdfDocRef.current) return null;
    try {
      const page = await pdfDocRef.current.getPage(pageId);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch (e) {
      console.warn("Visual image extraction skipped for page", pageId, e);
      return null;
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    
    const fileName = file.name.toLowerCase();
    const isPdf = fileName.endsWith('.pdf');

    if (!isPdf) {
      setErrorMsg("Invalid format. Please upload a PDF document.");
      return;
    }

    // PDF Size Limit: 100MB max
    if (file.size > 100 * 1024 * 1024) {
      setErrorMsg("File size exceeds 100MB limit. Please upload a smaller document.");
      return;
    }

    if (!window.pdfjsLib) {
      setErrorMsg("PDF Engine initializing. Please try again in a few seconds.");
      return;
    }
    
    setFileData({ name: file.name, size: (file.size / (1024 * 1024)).toFixed(2) });
    setIsParsing(true);
    setParseProgress(0);
    
    try {
      const sections = [];

      if (isPdf) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        pdfDocRef.current = pdf;
        
        for (let i = 1; i <= pdf.numPages; i++) {
          // Yield to main thread every 5 pages to prevent browser freezing on large 1000+ page PDFs
          if (i % 5 === 0) {
            setParseProgress(Math.round((i / pdf.numPages) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
          }

          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();

          // Sort items by their geometric position (line/row first, using the
          // transform's Y coordinate, then by X within a line) rather than
          // trusting the raw content-stream order. This meaningfully improves
          // reliability on multi-column layouts and RTL (Arabic/Urdu) pages,
          // where PDF.js's raw item order can otherwise scramble reading order.
          const isRtlPage = sourceLangMode === 'ar_ur';
          const positionedItems = textContent.items
            .filter(item => item.str !== undefined)
            .map(item => ({
              str: item.str,
              x: item.transform ? item.transform[4] : 0,
              y: item.transform ? item.transform[5] : 0
            }));

          const lineTolerance = 3; // px tolerance to group items onto the same visual line
          positionedItems.sort((a, b) => {
            if (Math.abs(a.y - b.y) > lineTolerance) return b.y - a.y; // top to bottom
            return isRtlPage ? b.x - a.x : a.x - b.x; // right-to-left for Arabic/Urdu, else left-to-right
          });

          let pageRawText = positionedItems.map(item => item.str).join(" ");

          sections.push({
            id: i,
            meta: { partName: `Page ${i}` },
            content: { rawText: pageRawText },
            sourceHtml: "", 
            originalSourceHtml: "", // Added for Redo/Undo support
            banglaHtml: "", 
            extractionStatus: 'idle',
            translationStatus: 'idle',
            hasBuffer: false,
            isPdf: true,
            detectedDir: sourceLangMode === 'ar_ur' ? 'rtl' : sourceLangMode === 'en' ? 'ltr' : 'auto'
          });
        }
      }
      
      setParsedSections(sections);
      if (sections.length > 0) {
        setActiveSectionId(sections[0].id);
        setSuccessMsg("Document loaded successfully! Ready for Layout Extraction.");
      } else {
        setErrorMsg("No readable text found in the uploaded file.");
      }
    } catch (error) {
      console.error(error);
      setErrorMsg("Error reading the file. Please verify the document.");
    } finally {
      setIsParsing(false);
    }
  };

  const scheduleRequestSlot = () => {
    const slot = throttleRef.current.then(async () => {
      const now = Date.now();
      const wait = REQUEST_INTERVAL_MS - (now - lastRequestTimeRef.current);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      lastRequestTimeRef.current = Date.now();
    });
    throttleRef.current = slot.catch(() => {});
    return slot;
  };

  const callGemini = async (parts) => {
    const activeKeys = apiKeys.map(k => k.trim()).filter(Boolean);
    if (activeKeys.length === 0) {
      throw new Error("NO_API_KEY");
    }

    const rot = rotationRef.current;
    if (rot.keyIdx >= activeKeys.length) rot.keyIdx = 0;

    const maxAttempts = activeKeys.length * GEMINI_MODELS.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      while (rot.deadKeys.has(rot.keyIdx) && rot.deadKeys.size < activeKeys.length) {
        rot.keyIdx = (rot.keyIdx + 1) % activeKeys.length;
        rot.modelIdx = 0;
        rot.count = 0;
      }
      if (rot.deadKeys.size >= activeKeys.length) {
        throw new Error("ALL_KEYS_EXHAUSTED");
      }

      const activeKey = activeKeys[rot.keyIdx];
      const activeModel = GEMINI_MODELS[rot.modelIdx];
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${activeKey}`;

      await scheduleRequestSlot();

      try {
        const data = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] })
        });

        rot.count += 1;
        if (rot.count >= MAX_REQUESTS_PER_KEY_MODEL) {
          rot.modelIdx += 1;
          rot.count = 0;
          if (rot.modelIdx >= GEMINI_MODELS.length) {
            rot.modelIdx = 0;
            rot.keyIdx = (rot.keyIdx + 1) % activeKeys.length;
          }
        }
        return data;
      } catch (error) {
        const status = error.status;
        const isQuotaError = status === 429 || /RESOURCE_EXHAUSTED/i.test(error.message || "");
        const isKeyError = status === 400 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(error.message || "");

        if (isQuotaError) {
          rot.modelIdx += 1;
          rot.count = 0;
          if (rot.modelIdx >= GEMINI_MODELS.length) {
            rot.modelIdx = 0;
            rot.keyIdx = (rot.keyIdx + 1) % activeKeys.length;
          }
          attempts += 1;
          continue;
        }

        if (isKeyError) {
          rot.deadKeys.add(rot.keyIdx);
          rot.keyIdx = (rot.keyIdx + 1) % activeKeys.length;
          rot.modelIdx = 0;
          rot.count = 0;
          attempts += 1;
          continue;
        }

        throw error;
      }
    }

    throw new Error("ALL_KEYS_EXHAUSTED");
  };

  const extractSourceLayout = async (pageText, pageId, isPdf) => {
    let imagePayload = null;
    if (isPdf) {
      const base64Image = await extractPageImageBase64(pageId);
      if (base64Image) {
        imagePayload = {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image
          }
        };
      }
    }

    const langInstruction = sourceLangMode === 'ar_ur' 
      ? "SOURCE LANGUAGE: Arabic / Urdu. Use RTL text direction (direction: rtl; text-align: right;)."
      : sourceLangMode === 'en'
      ? "SOURCE LANGUAGE: English. Use LTR text direction (direction: ltr; text-align: left;)."
      : "SOURCE LANGUAGE: Auto-detect (Arabic/Urdu -> RTL; English -> LTR).";

    const prompt = `
      EXTRACT SOURCE TEXT (ARABIC / URDU / ENGLISH) AND RECONSTRUCT EXACT VISUAL DESIGN LAYOUT IN HTML.
      
      ROLE: You are an expert designer and OCR processor. Process the raw text and map it PRECISELY to a beautiful styled HTML layout mimicking the ORIGINAL PDF 100%.
      ${langInstruction}
      
      RAW TEXT CONTENT:
      """
      ${pageText}
      """

      --- IMAGE OCR & BLANK PAGE HANDLING ---
      If "RAW TEXT CONTENT" is empty, garbage, or incomplete (e.g., a scanned image-only PDF), rely ENTIRELY on the provided image to perform OCR and extract the full source text accurately.
      If the image and text BOTH contain no readable content (completely blank page), ignore all layout rules and output EXACTLY:
      <p style="text-align: center; color: #94A3B8; font-style: italic; font-size: 16px; margin-top: 40px;">No Text Found</p>
      If you detect an image, diagram, or chart in the source layout, output the following EXACT HTML in its spatial place:
      <div class="diagram-placeholder" style="border: 2px dashed #CBD5E1; padding: 20px; text-align: center; border-radius: 8px; margin: 16px 0;"><p style="font-size: 14px; color: #64748B; margin-bottom: 8px;">Image Detected. Click to upload replacement.</p><input type="file" accept="image/*" class="diagram-upload-input" /></div>

      --- STRICT 100% LAYOUT FIDELITY INSTRUCTIONS ---
      CRITICAL: You must preserve the EXACT paragraph breaks, lists, tables, spatial arrangements, and physical structure of the original document page. 
      - DO NOT re-order, combine, or split paragraphs.
      - DO NOT summarize, hallucinate, or omit any text.
      - Your output must be a 1:1 structural mirror of the source document's layout.

      --- BEAUTIFICATION & STYLING INSTRUCTIONS (INLINE CSS ONLY) ---
      Apply these exact styles to the 100% faithful structure:
      1. Output ONLY raw source text wrapped inside clean styled HTML elements. Do NOT translate to Bangla yet! Keep original language.
      2. Set outer wrapper text-align and direction appropriately (RTL for Arabic/Urdu, LTR for English).
      3. Heading 1: <p style="text-align: center; color: #4338CA; font-size: 24px; font-weight: bold; margin-bottom: 20px;">...</p>
      4. Heading 2: <p style="color: #0F172A; font-size: 20px; font-weight: bold; margin-bottom: 12px; border-bottom: 1px solid #E2E8F0; padding-bottom: 8px;">...</p>
      5. Body text: <p style="text-align: justify; color: #334155; font-size: 18px; line-height: 1.8; margin-bottom: 16px;">...</p>
      6. Highlights: Use <span style="color: #BE123C; font-weight: bold;">...</span> for emphasis/Quranic verses/key terms.
      7. Footnotes: <div class="footnotes" style="margin-top: 24px; border-top: 1px solid #E2E8F0; padding-top: 12px;"><p style="color: #64748B; font-size: 14px;">...</p></div>

      --- PAGE JUNCTION / SENTENCE CUT-OFF DETECTION ---
      Examine the last sentence of the raw text. If it is cut-off or mid-sentence (ends without proper punctuation like ".", "؟", "!", "۔"), it indicates a split across pages.
      - If split/cut-off detected: Add EXACT tag at the end: <div id="junction-warning" data-incomplete="true"></div>
      - If sentence is complete: Add EXACT tag at the end: <div id="junction-warning" data-incomplete="false"></div>

      DO NOT use markdown code blocks (\`\`\`html). Output raw styled HTML directly.
    `;

    try {
      const data = await callGemini([
        { text: prompt },
        ...(imagePayload ? [imagePayload] : [])
      ]);

      const rawHtml = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/```html|```/gi, '').trim();
      return rawHtml;
    } catch (e) {
      console.error("Layout extraction error:", e);
      if (e.message === 'NO_API_KEY') {
        setErrorMsg("Please enter at least one Gemini API key in Settings.");
      } else if (e.message === 'ALL_KEYS_EXHAUSTED') {
        setErrorMsg("All Gemini API keys have reached their limit or are invalid. Please add more keys in Settings.");
      } else {
        setErrorMsg(`Layout extraction failed: ${e.message}`);
      }
      return null;
    }
  };

  const translateToBangla = async (sourceHtml) => {
    const prompt = `
      TRANSLATE SOURCE HTML (ARABIC / URDU / ENGLISH) TO HIGH-QUALITY BANGLA HTML PERFECTLY.
      
      You are an expert scholar and translator specializing in Arabic, Urdu, and English to Bangla translations.
      
      CRITICAL STRICT 100% MIRRORING INSTRUCTIONS:
      1. Translate all text accurately into natural, elegant, fluent Bangla.
      2. Preserve Quranic verses / Arabic terms accurately with standard Bangla transliteration or explanation if included.
      3. DO NOT alter ANY HTML tags, HTML structure, inline CSS styles, colors, alignments, font sizes, margins, or paddings.
      4. STRICT 1:1 NODE MAPPING: For every single HTML tag (<p>, <div>, <span>, <ul>, <li>, etc.) in the source document, you MUST maintain that exact same tag in the output.
      5. Only replace the inner text content with Bangla translated text. Do not add or remove any HTML elements whatsoever.
      6. Output ONLY raw HTML. Do not enclose in markdown blocks (\`\`\`html).
      7. If source contains "No Text Found", return the exact same HTML without changes.

      SOURCE STRUCTURED HTML:
      """
      ${sourceHtml}
      """
    `;

    try {
      const data = await callGemini([{ text: prompt }]);

      let rawHtml = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/```html|```/gi, '').trim();
      
      // Force Left-to-Right (LTR) flow for Bangla text by overriding Arabic/Urdu RTL inline styles
      if (rawHtml) {
        rawHtml = rawHtml
          .replace(/direction:\s*rtl;?/gi, 'direction: ltr;')
          .replace(/text-align:\s*right;?/gi, 'text-align: left;')
          .replace(/dir=["']?rtl["']?/gi, 'dir="ltr"');
      }

      return rawHtml;
    } catch (e) {
      console.error("Translation error:", e);
      if (e.message === 'NO_API_KEY') {
        setErrorMsg("Please enter at least one Gemini API key in Settings.");
      } else if (e.message === 'ALL_KEYS_EXHAUSTED') {
        setErrorMsg("All Gemini API keys have reached their limit or are invalid. Please add more keys in Settings.");
      } else {
        setErrorMsg(`Translation failed: ${e.message}`);
      }
      return null;
    }
  };

  // Concurrency limit for batch processing: pages are processed in parallel
  // (bounded) instead of one-at-a-time, which meaningfully speeds up long
  // documents while staying gentle on API rate limits.
  const BATCH_CONCURRENCY = 3;

  const startSequentialAnalysis = async () => {
    if (isTranslatingAll) return;
    setIsTranslatingAll(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const pages = [...parsedSections];
    let totalPages = pages.length;
    let completedCount = 0;

    const processPage = async (i) => {
      const page = pages[i];
      
      if (page.extractionStatus !== 'done') {
        setParsedSections(prev => {
          const copy = [...prev];
          copy[i].extractionStatus = 'loading';
          return copy;
        });

        const sourceHtmlResult = await extractSourceLayout(page.content.rawText, page.id, page.isPdf);
        
        if (sourceHtmlResult) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(sourceHtmlResult, 'text/html');
          const warningEl = doc.getElementById('junction-warning');
          const isBuffered = warningEl ? warningEl.getAttribute('data-incomplete') === 'true' : false;
          if (warningEl) warningEl.remove();

          // Detect direction
          const hasArabicChar = /[\u0600-\u06FF]/.test(doc.body.innerText || "");
          const isRtl = hasArabicChar || sourceLangMode === 'ar_ur';

          setParsedSections(prev => {
            const copy = [...prev];
            copy[i].sourceHtml = doc.body.innerHTML;
            copy[i].originalSourceHtml = doc.body.innerHTML; // Store original state for resetting
            copy[i].hasBuffer = isBuffered;
            copy[i].extractionStatus = 'done';
            copy[i].detectedDir = isRtl ? 'rtl' : 'ltr';
            
            if (isBuffered) {
              copy[i].translationStatus = 'paused';
            }
            return copy;
          });

          if (!isBuffered) {
            setParsedSections(prev => {
              const copy = [...prev];
              copy[i].translationStatus = 'loading';
              return copy;
            });

            const banglaHtmlResult = await translateToBangla(doc.body.innerHTML);
            setParsedSections(prev => {
              const copy = [...prev];
              if (banglaHtmlResult) {
                copy[i].banglaHtml = banglaHtmlResult;
                copy[i].translationStatus = 'done';
              } else {
                copy[i].translationStatus = 'error';
              }
              return copy;
            });
          }
        } else {
          setParsedSections(prev => {
            const copy = [...prev];
            copy[i].extractionStatus = 'error';
            return copy;
          });
        }
      } else {
        if (!page.hasBuffer && page.translationStatus !== 'done') {
          setParsedSections(prev => {
            const copy = [...prev];
            copy[i].translationStatus = 'loading';
            return copy;
          });

          const editorElem = document.getElementById(`editor-${page.id}`);
          const latestSourceHtml = editorElem ? editorElem.innerHTML : page.sourceHtml;
          if (editorElem) {
            setParsedSections(prev => {
              const copy = [...prev];
              copy[i].sourceHtml = latestSourceHtml;
              return copy;
            });
          }
          const banglaHtmlResult = await translateToBangla(latestSourceHtml);
          setParsedSections(prev => {
            const copy = [...prev];
            if (banglaHtmlResult) {
              copy[i].banglaHtml = banglaHtmlResult;
              copy[i].translationStatus = 'done';
            } else {
              copy[i].translationStatus = 'error';
            }
            return copy;
          });
        }
      }

      completedCount += 1;
      setProgress(Math.round((completedCount / totalPages) * 100));
    };

    // Bounded-concurrency worker pool: a fixed number of "workers" pull the
    // next page index off a shared cursor until all pages are processed.
    let nextIndex = 0;
    const runWorker = async () => {
      while (nextIndex < totalPages) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await processPage(currentIndex);
      }
    };

    const workerCount = Math.min(BATCH_CONCURRENCY, totalPages) || 1;
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    setIsTranslatingAll(false);
    setSuccessMsg("Batch processing complete! Pages with incomplete sentence splits have been paused for review.");
  };

  const syncSinglePageTranslation = async (pageId) => {
    const idx = parsedSections.findIndex(s => s.id === pageId);
    if (idx === -1) return;

    setErrorMsg(null);

    // Read the latest content directly from the live editor DOM node if it's
    // currently mounted, rather than trusting parsedSections.sourceHtml, which
    // only updates on the editor's onBlur event. This avoids translating stale
    // text if the user clicks "Sync Text" without first clicking away from
    // the editable panel.
    const editorElem = document.getElementById(`editor-${pageId}`);
    const currentEditedText = editorElem ? editorElem.innerHTML : parsedSections[idx].sourceHtml;

    setParsedSections(prev => {
      const copy = [...prev];
      copy[idx].sourceHtml = currentEditedText;
      copy[idx].translationStatus = 'loading';
      return copy;
    });

    const banglaHtmlResult = await translateToBangla(currentEditedText);

    setParsedSections(prev => {
      const copy = [...prev];
      if (banglaHtmlResult) {
        copy[idx].banglaHtml = banglaHtmlResult;
        copy[idx].translationStatus = 'done';
        copy[idx].hasBuffer = false;
        setSuccessMsg(`Section ${pageId} Mirrored Translation Synchronized successfully!`);
      } else {
        copy[idx].translationStatus = 'error';
        setErrorMsg(`Failed to translate section ${pageId}. Please retry.`);
      }
      return copy;
    });
  };

  const handleEditableContentBlur = (pageId, event) => {
    const updatedHtml = event.target.innerHTML;
    setParsedSections(prev => {
      return prev.map(s => s.id === pageId ? { ...s, sourceHtml: updatedHtml } : s);
    });
  };

  const handleResetSection = (pageId) => {
    setParsedSections(prev => prev.map(s => {
      if (s.id === pageId && s.originalSourceHtml) {
        return {
          ...s,
          sourceHtml: s.originalSourceHtml, // Revert to original extracted HTML
          translationStatus: 'idle', // Reset translation so user can re-sync
          banglaHtml: ''
        };
      }
      return s;
    }));
    setSuccessMsg(`Section ${pageId} reset to its original extracted state.`);
  };

  const handleSaveSettings = () => {
    const keys = apiKeys.map(k => k.trim());
    if (!keys[0]) {
      setErrorMsg("Please enter at least the first Gemini API key.");
      return;
    }

    // Always keep a session-scoped copy so the current tab keeps working.
    sessionStorage.setItem('translator_api_keys', JSON.stringify(keys));

    if (rememberApiKey) {
      localStorage.setItem('translator_api_keys', JSON.stringify(keys));
    } else {
      // If the user opts out (or opts back out later), make sure no stale
      // keys are left behind in durable storage.
      localStorage.removeItem('translator_api_keys');
    }

    setApiKeys(keys);
    rotationRef.current = { keyIdx: 0, modelIdx: 0, count: 0, deadKeys: new Set() };
    setShowSettings(false);
    setSuccessMsg("Settings saved successfully.");
  };

  const exportHtml = async () => {
    if (isExporting) return;
    setIsExporting(true);
    setErrorMsg(null);
    
    const finishedTranslations = parsedSections.filter(s => s.translationStatus === 'done');
    if (finishedTranslations.length === 0) {
      setErrorMsg("No translated pages found. Please process at least one section first.");
      setIsExporting(false);
      return;
    }

    try {
      let htmlContent = `
        <!DOCTYPE html>
        <html lang="bn">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Mirrored Translation - ${fileData?.name || 'Document'}</title>
          <link href="https://fonts.maateen.me/kalpurush/font.css" rel="stylesheet">
          <style>
            body, .translated-section, .translated-section * {
              font-family: 'Kalpurush', sans-serif !important;
            }
            body {
              background-color: #f8fafc;
              color: #0f172a;
              line-height: 1.8;
              padding: 2rem 1rem;
              max-width: 850px;
              margin: 0 auto;
            }
            .section-break {
              border-bottom: 2px dashed #cbd5e1;
              margin: 3rem 0;
              padding-bottom: 2rem;
              position: relative;
            }
            .section-marker {
              position: absolute;
              bottom: -10px;
              left: 50%;
              transform: translateX(-50%);
              background: #f8fafc;
              padding: 0 1rem;
              color: #94a3b8;
              font-size: 13px;
              font-weight: bold;
              font-family: sans-serif;
            }
            @media print {
              body { background: white; padding: 0; max-width: none; }
              .section-break { border: none; margin: 0; padding: 0; page-break-after: always; }
              .section-marker { display: none; }
            }
          </style>
        </head>
        <body>
      `;

      parsedSections.forEach((s) => {
        if (s.translationStatus !== 'done') return;
        htmlContent += `
          <div class="translated-section" id="section-${s.id}">
            <div dir="ltr">
              ${sanitizeHtml(s.banglaHtml)}
            </div>
          </div>
          <div class="section-break">
            <span class="section-marker">SECTION ${s.id}</span>
          </div>
        `;
      });

      htmlContent += `
        </body>
        </html>
      `;

      const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Translated_Bangla_${(fileData?.name || 'Document').split('.')[0]}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      setSuccessMsg("Document exported to HTML format successfully!");
    } catch (e) {
      setErrorMsg("Export failed. An error occurred while generating HTML.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyText = async (text, id) => {
    const tempEl = document.createElement('div');
    tempEl.innerHTML = text;
    const plainText = tempEl.innerText || tempEl.textContent || '';

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(plainText);
      } else {
        // Legacy fallback clipboard copy for older/insecure-context browsers
        const textarea = document.createElement('textarea');
        textarea.value = plainText;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
      setErrorMsg("Couldn't copy to clipboard. Please try selecting the text manually.");
    }
  };

  const activePage = parsedSections.find(s => s.id === activeSectionId);

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-950">
      
      {/* Top Header Navigation Bar */}
      <nav className="relative z-40 bg-white border-b border-slate-200/80 px-6 py-3 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-indigo-100">
            <BookOpen size={20} />
          </div>
          <div>
            <h1 className="text-base font-extrabold text-slate-800 tracking-tight leading-none mb-1">
              Ar/En/Ur to Bangla Translator
            </h1>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
              <Globe size={10} className="text-indigo-500" /> MULTILINGUAL MIRROR LAYOUT STUDIO
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Source Language Selector */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button 
              onClick={() => setSourceLangMode('auto')}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${sourceLangMode === 'auto' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
              title="Auto Detect Language"
            >
              Auto
            </button>
            <button 
              onClick={() => setSourceLangMode('ar_ur')}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${sourceLangMode === 'ar_ur' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
              title="Arabic & Urdu Mode (RTL)"
            >
              العربية / اردو
            </button>
            <button 
              onClick={() => setSourceLangMode('en')}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${sourceLangMode === 'en' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
              title="English Mode (LTR)"
            >
              English
            </button>
          </div>

          {parsedSections.length > 0 && (
            <>
              <button 
                onClick={startSequentialAnalysis} 
                disabled={isTranslatingAll}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-xs font-bold flex items-center gap-2 disabled:opacity-50 transition-all shadow-sm shadow-indigo-200 cursor-pointer"
              >
                {isTranslatingAll ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Analyzing ({progress}%)</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    <span>Translate Entire Document</span>
                  </>
                )}
              </button>
              <button 
                onClick={exportHtml} 
                disabled={isExporting}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-950 text-white rounded-xl text-xs font-bold flex items-center gap-2 disabled:opacity-50 transition-all shadow-sm cursor-pointer"
              >
                {isExporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
                <span>Export HTML</span>
              </button>
            </>
          )}

          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 transition-all cursor-pointer"
            title="Settings"
          >
            <Settings size={18} />
          </button>

          <button 
            onClick={() => setShowHelpModal(true)}
            className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 transition-all cursor-pointer"
            title="Workflow Guide"
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </nav>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100">
            <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                <Settings size={18} className="text-indigo-600" /> Application Settings
              </h3>
              <button onClick={() => setShowSettings(false)} className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer">
                <X size={18} />
              </button>
            </div>
            
            <div className="space-y-4 text-xs text-slate-600">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Gemini API Keys</label>
                <p className="text-[10px] text-slate-400 mb-2">Key 1 is required. Keys 2-10 are optional and are used automatically once earlier keys reach their limit.</p>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {apiKeys.map((k, idx) => (
                    <div key={idx}>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">
                        API Key {idx + 1} {idx === 0 ? '(Required)' : '(Optional)'}
                      </label>
                      <input
                        type="password"
                        value={k}
                        onChange={(e) => {
                          const next = [...apiKeys];
                          next[idx] = e.target.value;
                          setApiKeys(next);
                        }}
                        placeholder={idx === 0 ? "Enter your Gemini API key" : "Enter Gemini API key (optional)"}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 outline-none"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-400 mt-2">By default your keys are kept only for this browser tab/session and are cleared when you close it.</p>
                <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberApiKey}
                    onChange={(e) => setRememberApiKey(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200 cursor-pointer"
                  />
                  <span className="text-[10px] text-slate-500">Remember these keys on this device (stores them in Local Storage across sessions)</span>
                </label>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Source Language Preset</label>
                <select 
                  value={sourceLangMode}
                  onChange={(e) => setSourceLangMode(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 outline-none"
                >
                  <option value="auto">Auto Detect Direction & Script</option>
                  <option value="ar_ur">Arabic / Urdu Mode (RTL Layout)</option>
                  <option value="en">English Mode (LTR Layout)</option>
                </select>
              </div>
            </div>

            <div className="mt-6 pt-3 border-t border-slate-100 flex justify-end">
              <button 
                onClick={handleSaveSettings}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Help Workflow Modal */}
      {showHelpModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-100">
            <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                <Sparkles size={18} className="text-indigo-600" /> Multilingual Translation Guide
              </h3>
              <button onClick={() => setShowHelpModal(false)} className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer">
                <X size={18} />
              </button>
            </div>
            
            <div className="space-y-4 text-xs text-slate-600 leading-relaxed">
              <p>This studio translates documents from <strong>Arabic, Urdu, or English</strong> to <strong>Bangla</strong> while preserving original visual layouts and solving split sentences across page breaks.</p>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                  <span className="font-bold text-indigo-600 text-[10px] uppercase block mb-1">1. Upload & Extract</span>
                  Upload a PDF. Click <strong>"Translate Entire Document"</strong>. The AI extracts layout geometry, headings, and scripture highlighting into the left panel.
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                  <span className="font-bold text-amber-600 text-[10px] uppercase block mb-1">2. Edit Cut-offs</span>
                  If a sentence is cut off mid-phrase at the bottom of a page, translation pauses. You can edit the text directly in the left workspace to fix split sentences.
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                  <span className="font-bold text-emerald-600 text-[10px] uppercase block mb-1">3. Sync to Bangla</span>
                  Click <strong>"Sync Text"</strong> on the left sidebar for that page to reflect the flawless mirrored Bangla translation in the right workspace!
                </div>
              </div>
            </div>

            <div className="mt-6 pt-3 border-t border-slate-100 flex justify-end">
              <button 
                onClick={() => setShowHelpModal(false)}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-950 text-white text-xs font-bold rounded-xl cursor-pointer"
              >
                Got it, let's start!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main App Content View */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        
        {isParsing ? (
          /* Parsing Loading State for Large PDFs */
          <div className="flex-1 flex flex-col items-center justify-center space-y-4 max-w-4xl mx-auto w-full p-6 text-center animate-in fade-in duration-500">
            <Loader2 size={48} className="animate-spin text-indigo-600" />
            <div>
              <h3 className="text-xl font-bold text-slate-800">Reading Document...</h3>
              <p className="text-sm text-slate-500 mt-2">Extracting structure and text layer. This might take a moment for large files.</p>
            </div>
            {parseProgress > 0 && (
              <div className="w-64 mt-4 space-y-2">
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${parseProgress}%` }}></div>
                </div>
                <p className="text-xs font-bold text-slate-500">{parseProgress}% Complete</p>
              </div>
            )}
          </div>
        ) : !fileData ? (
          /* Empty Upload View */
          <div className="flex-1 max-w-4xl mx-auto w-full p-6 md:p-12 flex flex-col justify-center">
            <div className="text-center mb-8 max-w-2xl mx-auto">
              <span className="bg-indigo-50 text-indigo-700 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest mb-4 inline-block border border-indigo-100">
                Arabic • Urdu • English to Bangla Mirror Studio
              </span>
              <h2 className="text-3xl md:text-5xl font-black text-slate-900 tracking-tight mb-4 leading-tight">
                Preserve Original Layouts. <br/>
                <span className="text-indigo-600">Translate to Bangla.</span>
              </h2>
              <p className="text-slate-500 text-sm md:text-base leading-relaxed">
                Upload Arabic, Urdu, or English PDF books. Reconstruct visual layouts, solve page-junction text splits, and generate publication-ready Bangla translations (exported as HTML).
              </p>
            </div>
            
            <label className="group block w-full max-w-xl mx-auto aspect-video border-3 border-dashed border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/10 rounded-2xl bg-white transition-all cursor-pointer relative overflow-hidden shadow-xs">
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-14 h-14 bg-slate-50 group-hover:bg-indigo-50 rounded-2xl flex items-center justify-center mb-4 transition-all">
                  <Upload size={24} className="text-slate-400 group-hover:text-indigo-600" />
                </div>
                <div className="space-y-2">
                  <span className="bg-slate-900 text-white px-6 py-2.5 rounded-xl font-bold text-xs block shadow-md shadow-slate-200 group-hover:bg-indigo-600 transition-colors">
                    Browse PDF File
                  </span>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Supports .pdf documents</p>
                </div>
              </div>
              <input type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
        ) : (
          /* Active Document Workspace */
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden w-full">
            
            {/* Left Sidebar: Section / Page Selector */}
            <aside className="w-full md:w-72 bg-white border-b md:border-b-0 md:border-r border-slate-200/80 flex flex-col h-full shrink-0">
              
              <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center shrink-0">
                    <FileText size={16} />
                  </div>
                  <div className="overflow-hidden">
                    <h4 className="text-xs font-bold text-slate-800 truncate" title={fileData.name}>{fileData.name}</h4>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{parsedSections.length} Sections • {fileData.size} MB</p>
                  </div>
                </div>
                
                <button 
                  onClick={() => {
                    try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* ignore */ }
                    window.location.reload();
                  }} 
                  className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all cursor-pointer"
                  title="Close Document (clears saved session)"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="px-4 py-2 bg-slate-100/50 text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-slate-100">
                Document Navigation
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {parsedSections.map((s) => {
                  const isActive = activeSectionId === s.id;
                  let statusBg = "bg-slate-100 text-slate-500";
                  if (isActive) statusBg = "bg-indigo-600 text-white shadow-xs";
                  
                  return (
                    <div 
                      key={s.id}
                      className={`w-full text-left px-3 py-2.5 rounded-xl flex flex-col transition-all ${isActive ? 'bg-indigo-50/80 border border-indigo-100/50 shadow-xs' : 'hover:bg-slate-50 border border-transparent'}`}
                    >
                      <div 
                        onClick={() => setActiveSectionId(s.id)}
                        className="flex items-center justify-between cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`w-7 h-7 flex items-center justify-center rounded-lg font-black text-xs shrink-0 ${statusBg}`}>
                            {s.id}
                          </span>
                          <div className="min-w-0">
                            <span className={`text-xs block truncate ${isActive ? 'text-indigo-950 font-bold' : 'text-slate-700 font-semibold'}`}>
                              {s.meta.partName}
                            </span>
                            <span className="text-[9px] text-slate-400 block leading-tight font-semibold">
                              {s.extractionStatus === 'idle' ? 'Not Processed' : s.extractionStatus === 'loading' ? 'Analyzing...' : 'Layout Ready'}
                            </span>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-1.5">
                          {s.hasBuffer && (
                            <span className="px-1.5 py-0.5 rounded-md text-[8px] font-black bg-amber-100 text-amber-700 animate-pulse border border-amber-200">
                              PAUSED
                            </span>
                          )}
                          {s.translationStatus === 'done' && !s.hasBuffer && (
                            <span className="w-2 h-2 rounded-full bg-emerald-500" title="Translated" />
                          )}
                          {s.translationStatus === 'loading' && (
                            <Loader2 size={12} className="animate-spin text-indigo-500" />
                          )}
                          {s.translationStatus === 'error' && (
                            <span className="w-2 h-2 rounded-full bg-red-500" title="Failed" />
                          )}
                          <ChevronRight size={14} className={isActive ? 'text-indigo-400' : 'text-slate-300'} />
                        </div>
                      </div>

                      {s.extractionStatus !== 'idle' && (
                        <div className="mt-2.5 pl-10 pr-1 flex items-center gap-1.5">
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveSectionId(s.id);
                              syncSinglePageTranslation(s.id);
                            }}
                            disabled={s.extractionStatus !== 'done' || s.translationStatus === 'loading'}
                            className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all shadow-xs cursor-pointer ${s.hasBuffer ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-200' : 'bg-white border border-slate-200 hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50 text-slate-600'} disabled:opacity-50`}
                          >
                            {s.translationStatus === 'loading' ? (
                              <>
                                <Loader2 size={10} className="animate-spin" />
                                <span>Syncing...</span>
                              </>
                            ) : (
                              <>
                                <RefreshCw size={10} />
                                <span>Sync Text</span>
                              </>
                            )}
                          </button>
                          
                          {/* Reset / Refresh Button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleResetSection(s.id);
                            }}
                            disabled={s.extractionStatus !== 'done'}
                            title="Reset to Original Extraction"
                            className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all cursor-pointer disabled:opacity-50 shrink-0"
                          >
                            <RotateCcw size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>

            {/* Main Dual Workspace Editor */}
            <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
              
              {/* Workspace Header Sub-bar */}
              <div className="bg-white border-b border-slate-200/80 px-6 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">Workspace:</span>
                  <span className="text-xs font-extrabold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-md">
                    Section {activeSectionId} Workspace
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {activePage?.hasBuffer && (
                    <span className="text-[10px] font-black bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-md flex items-center gap-1.5" title="Sentence split detected at bottom of section. Edit left panel then click Sync Text.">
                      <LinkIcon size={12} className="text-amber-500" /> Incomplete Split Alert
                    </span>
                  )}
                </div>
              </div>

              {/* Dual Panels */}
              <div className="flex-1 flex flex-col lg:flex-row overflow-hidden p-6 gap-6">
                
                {/* Source Document Editable Panel */}
                <div className="flex-1 flex flex-col bg-white rounded-xl border border-slate-200/80 overflow-hidden shadow-xs">
                  
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <Edit3 size={14} className="text-indigo-500" /> 1. Source Document Layout (Arabic / Urdu / English)
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">
                        {activePage?.detectedDir === 'rtl' ? 'RTL Layout' : 'LTR Layout'}
                      </span>
                      {activePage?.sourceHtml && (
                        <button 
                          onClick={() => handleCopyText(activePage.sourceHtml, `source-${activeSectionId}`)}
                          className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-all cursor-pointer"
                          title="Copy Source Text"
                        >
                          {copiedId === `source-${activeSectionId}` ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 md:p-8 bg-white flex flex-col">
                    {(() => {
                      if (!activePage) return null;
                      
                      if (activePage.extractionStatus === 'idle') {
                        return (
                          <div className="m-auto flex flex-col items-center justify-center text-center p-6 space-y-3">
                            <div className="w-10 h-10 bg-indigo-50 text-indigo-500 rounded-full flex items-center justify-center">
                              <Sparkles size={18} className="animate-pulse" />
                            </div>
                            <div className="max-w-xs space-y-1">
                              <h4 className="text-xs font-bold text-slate-800">Source Layout Analysis Required</h4>
                              <p className="text-[11px] text-slate-400">Click "Translate Entire Document" to automatically analyze visual structure.</p>
                            </div>
                          </div>
                        );
                      }
                      
                      if (activePage.extractionStatus === 'loading') {
                        return (
                          <div className="m-auto flex flex-col items-center justify-center text-center p-6 space-y-3">
                            <div className="w-8 h-8 border-3 border-indigo-100 rounded-full animate-spin border-t-indigo-600"></div>
                            <div className="space-y-1">
                              <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Reconstructing Visual Layout...</p>
                              <p className="text-[10px] text-slate-400">Mapping headings, emphasis, and layout structure</p>
                            </div>
                          </div>
                        );
                      }

                      if (activePage.extractionStatus === 'error') {
                        return (
                          <div className="m-auto flex flex-col items-center justify-center text-center p-6 space-y-2">
                            <AlertCircle size={28} className="text-red-500" />
                            <div className="max-w-xs space-y-1">
                              <h4 className="text-xs font-bold text-slate-800">Extraction Failed</h4>
                              <p className="text-[11px] text-slate-400">An error occurred while reconstructing source layout. Please retry.</p>
                            </div>
                          </div>
                        );
                      }

                      const isRtl = activePage.detectedDir === 'rtl';

                      return (
                        <div className="flex-1 flex flex-col">
                          <p className="text-[10px] text-slate-400 mb-3 border-b border-dashed border-slate-100 pb-2 flex items-center gap-1">
                            💡 <strong>Interactive Editor:</strong> Double-click inside to edit, append split sentences, or adjust layout text before syncing.
                          </p>
                          <div 
                            id={`editor-${activeSectionId}`}
                            contentEditable={true}
                            onBlur={(e) => handleEditableContentBlur(activeSectionId, e)}
                            className={`mirror-flow ${isRtl ? 'arabic-urdu-font text-xl text-right' : 'english-font text-lg text-left'} outline-none ring-offset-2 focus:ring-2 focus:ring-indigo-100 rounded-xl flex-1 select-text`}
                            style={{ direction: isRtl ? 'rtl' : 'ltr' }}
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(activePage.sourceHtml) }}
                          />
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Mirrored Target Bangla Document Panel */}
                <div className="flex-1 flex flex-col bg-white rounded-xl border border-slate-200/80 overflow-hidden shadow-xs">
                  
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <Globe size={14} className="text-indigo-500" /> 2. Mirrored Target Layout (Bangla)
                    </span>
                    <div className="flex items-center gap-2">
                      {activePage?.translationStatus === 'done' && (
                        <>
                          <span className="text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-0.5 rounded-md flex items-center gap-1">
                            <CheckCircle2 size={10} /> Synced
                          </span>
                          <button 
                            onClick={() => handleCopyText(activePage.banglaHtml, `bangla-${activeSectionId}`)}
                            className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-all cursor-pointer"
                            title="Copy Bangla Text"
                          >
                            {copiedId === `bangla-${activeSectionId}` ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                          </button>
                        </>
                      )}
                      {activePage?.translationStatus === 'paused' && (
                        <span className="text-[9px] font-black bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-md flex items-center gap-1">
                          Paused for Review
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 md:p-8 bg-white">
                    {(() => {
                      if (!activePage) return null;
                      
                      if (activePage.translationStatus === 'idle') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                            <div className="w-10 h-10 bg-slate-50 text-slate-400 rounded-full flex items-center justify-center">
                              <Globe size={18} />
                            </div>
                            <div className="max-w-xs space-y-1">
                              <h4 className="text-xs font-bold text-slate-800">Unsynchronized Section</h4>
                              <p className="text-[11px] text-slate-400">After reviewing the source text on the left, click <strong>"Sync Text"</strong> in the sidebar to render the Bangla translation here.</p>
                            </div>
                          </div>
                        );
                      }
                      
                      if (activePage.translationStatus === 'loading') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                            <div className="w-8 h-8 border-3 border-indigo-100 rounded-full animate-spin border-t-indigo-600"></div>
                            <div className="space-y-1">
                              <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Translating to Bangla...</p>
                              <p className="text-[10px] text-slate-400">Mirroring document structure, style, and terminology</p>
                            </div>
                          </div>
                        );
                      }

                      if (activePage.translationStatus === 'paused') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4">
                            <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center border border-amber-100">
                              <LinkIcon size={22} className="animate-bounce" />
                            </div>
                            <div className="max-w-xs space-y-1">
                              <h4 className="text-xs font-extrabold text-amber-800 uppercase tracking-wide">Sync Paused (Split Sentence Alert)</h4>
                              <p className="text-[11px] text-slate-500 leading-relaxed">
                                An incomplete sentence split was detected at the bottom of this section. 
                                <br /><br />
                                <strong>Next Step:</strong> Review and adjust the text in the <strong>left source workspace</strong>, then click <strong>"Sync Text"</strong> on the left sidebar to generate the Bangla translation!
                              </p>
                            </div>
                          </div>
                        );
                      }

                      if (activePage.translationStatus === 'error') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-2">
                            <AlertCircle size={28} className="text-red-500" />
                            <div className="max-w-xs space-y-1">
                              <h4 className="text-xs font-bold text-slate-800">Translation Failed</h4>
                              <p className="text-[11px] text-slate-400">Error translating content to Bangla. Please retry.</p>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div 
                          className="mirror-flow bangla-font text-lg text-slate-800 animate-in fade-in duration-300"
                          id={`bangla-view-${activeSectionId}`}
                        >
                          <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(activePage.banglaHtml) }} />
                        </div>
                      );
                    })()}
                  </div>
                </div>

              </div>
            </div>

          </div>
        )}
      </main>

      {/* Toast Notifications */}
      {errorMsg && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-3.5 rounded-xl shadow-xl flex items-center gap-3 z-50 animate-in zoom-in slide-in-from-bottom-10 border border-slate-800 max-w-md w-[90%]">
          <AlertCircle className="text-red-400 shrink-0" size={18} />
          <span className="text-xs font-bold flex-1 leading-snug">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

      {successMsg && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-950 text-emerald-100 px-5 py-3.5 rounded-xl shadow-xl flex items-center gap-3 z-50 animate-in zoom-in slide-in-from-bottom-10 border border-emerald-900 max-w-md w-[90%]">
          <CheckCircle2 className="text-emerald-400 shrink-0" size={18} />
          <span className="text-xs font-bold flex-1 leading-snug">{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="p-1 hover:bg-white/10 rounded-lg text-emerald-400 hover:text-white cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

    </div>
  );
};

export default App;