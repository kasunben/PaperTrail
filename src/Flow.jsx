import React, { useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Position,
  useReactFlow,
  Handle,
} from '@xyflow/react';

// NOTE: Ensure XYFlow base styles are present during dev/HMR; host resets (sv_base.css) can clamp SVGs, so we inject styles on every module eval.
// import { ensureXYFlowStyles } from './xyflowStyles.js';
import { loadCache, createBoard, fetchBoard, saveCache, createSaver, onOnline } from './sync.js';
// ensureXYFlowStyles();

const normalizeUrl = (raw) => {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const withProto = trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
};

const fetchLinkPreview = async (url) => {
  const res = await fetch(`/api/plugins/papertrail/preview?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`preview failed ${res.status}`);
  return res.json();
};

const SEARCH_EDGE_CLASS = "pt-edge-match";

const normalizeSearchValue = (value) => {
  if (!value) return "";
  return String(value).toLowerCase();
};

const matchesSearch = (value, term) => {
  if (!term) return false;
  const candidate = normalizeSearchValue(value);
  return candidate.includes(term);
};

const sanitizeNodeChange = (change) => {
  if (!change || !change.data) return change;
  if (change.data._searchMatch === undefined) return change;
  const { _searchMatch, ...rest } = change.data;
  return { ...change, data: rest };
};

const sanitizeEdgeChange = (change) => {
  if (!change) return change;
  let next = change;
  if (next.data && next.data._searchMatch !== undefined) {
    const { _searchMatch, ...rest } = next.data;
    next = { ...next, data: rest };
  }
  if (next.className) {
    const cleaned = next.className
      .split(/\s+/)
      .filter((name) => name && name !== SEARCH_EDGE_CLASS)
      .join(" ");
    next = { ...next, className: cleaned || undefined };
  }
  return next;
};

const safeJsonParse = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const makeWsUrl = () => {
  if (typeof window === "undefined") return null;
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws`;
};

const MAX_IMAGE_PREVIEW_DIMENSION = 900;
const ASSET_UPLOAD_ENDPOINT = "/api/plugins/papertrail/assets";

const ensureImageCanvas = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const drawToCanvas = (canvas, source, width, height) => {
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
  }
};

const scaleDimensions = (width, height) => {
  const maxDim = Math.max(width, height, 1);
  const scale = maxDim > MAX_IMAGE_PREVIEW_DIMENSION ? MAX_IMAGE_PREVIEW_DIMENSION / maxDim : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const loadImageElement = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });

const createImagePreview = async (file) => {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImageElement(dataUrl);
  const { width, height } = scaleDimensions(img.naturalWidth, img.naturalHeight);
  const canvas = ensureImageCanvas(width, height);
  drawToCanvas(canvas, img, width, height);
  return canvas.toDataURL("image/jpeg", 0.8);
};

const uploadImageFile = async (file, projectId) => {
  const url = `${ASSET_UPLOAD_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, {
    method: "POST",
    body: file,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    credentials: "include",
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error || `Upload failed (${res.status})`);
  }
  return res.json();
};

// Small side handles (restore drag-to-connect like the original)
const handleStyle = { width: 8, height: 8, borderRadius: '50%', background: '#64748b', border: '2px solid #fff' };

// --- PaperTrail custom nodes (inline editing) ---
const TextNode = ({ id, data }) => {
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    title: data.title || '',
    text: data.text || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
  });
  const [tagInput, setTagInput] = React.useState('');
  const editableRef = React.useRef(null);
  const editorHtmlRef = React.useRef(draft.text || '');
  const titleInputRef = React.useRef(null);
  const placeCaretAtEnd = React.useCallback((el) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }, []);
  // Preserve editor DOM across any re-render while editing

  React.useLayoutEffect(() => {
    if (editing && editableRef.current) {
      const html = editorHtmlRef.current || '';
      if (editableRef.current.innerHTML !== html) {
        editableRef.current.innerHTML = html;
      }
    }
  });

  const commit = React.useCallback(() => {
    setEditing(false);
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, draggable: true, selectable: true, connectable: true } : n));
    const html = editableRef.current ? editableRef.current.innerHTML : editorHtmlRef.current;
    editorHtmlRef.current = html;
    const titleVal = titleInputRef.current ? titleInputRef.current.value : draft.title;
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title: titleVal, text: html, tags: draft.tags } } : n)));
  }, [draft.tags, draft.title, id, setNodes]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, draggable: true, selectable: true, connectable: true } : n));
    setDraft({
      title: data.title || '',
      text: data.text || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
    });
    setTagInput('');
  }, [data.title, data.text, data.tags]);

  const addTag = React.useCallback(() => {
    const t = tagInput.trim();
    if (!t) return;
    if (draft.tags.includes(t)) return;
    setDraft((d) => ({ ...d, tags: [...d.tags, t] }));
    setTagInput('');
  }, [tagInput, draft.tags]);

  const removeTag = (t) => setDraft((d) => ({ ...d, tags: d.tags.filter((x) => x !== t) }));

  return (
    <div
      className="pt-node pt-text"
      style={{
        padding: 12,
        borderRadius: 8,
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        background: '#fff',
        border: '1px solid',
        borderColor: data._searchMatch ? '#f97316' : '#e5e7eb',
        minWidth: 160,
        outline: data._isConnectSource ? '2px dashed #ef4444' : undefined,
        outlineOffset: 2,
      }}
      onDoubleClick={(e) => {
        if (editing) { e.stopPropagation(); return; }
        setDraft({
          title: data.title || '',
          text: data.text || '',
          tags: Array.isArray(data.tags) ? data.tags : [],
        });
        setEditing(true);
        // disable RF interactions while editing this node
        setNodes((ns) => ns.map((n) => n.id === id ? { ...n, draggable: false, selectable: false, connectable: false } : n));
        setTimeout(() => {
          if (editableRef.current) {
            const html = data.text || '';
            editableRef.current.innerHTML = html;
            editorHtmlRef.current = html;
            editableRef.current.focus();
            placeCaretAtEnd(editableRef.current);
          }
        }, 0);
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      {!editing && (data.title ? (
        <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{data.title}</div>
      ) : null)}

      {editing ? (
        <div
          className="pt-editor nodrag nowheel nopan"
          style={{ display: 'grid', gap: 6, userSelect: 'text', WebkitUserSelect: 'text', MozUserSelect: 'text', msUserSelect: 'text' }}
        >
          <input
            ref={titleInputRef}
            placeholder="Title (optional)"
            defaultValue={draft.title}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <div
            ref={editableRef}
            className="pt-body nodrag nowheel nopan"
            style={{ fontSize: 12, lineHeight: 1.35, minHeight: 80, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4, outline: 'none', cursor: 'text', userSelect: 'text', WebkitUserSelect: 'text', MozUserSelect: 'text', msUserSelect: 'text', WebkitUserDrag: 'none' }}
            contentEditable
            suppressContentEditableWarning
            onInput={() => { editorHtmlRef.current = editableRef.current ? editableRef.current.innerHTML : editorHtmlRef.current; }}
            onKeyDown={(e) => {
              const key = e.key.toLowerCase();
              const mod = e.metaKey || e.ctrlKey;
              if (mod && key === 'enter') { e.preventDefault(); commit(); return; }
              if (key === 'escape') { e.preventDefault(); cancel(); return; }
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          />
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {draft.tags.map((t) => (
                <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e0e7ff', borderRadius: 9999 }}>
                  {t}
                  <button title="Remove" onClick={() => removeTag(t)} style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, boxShadow: 'none' }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="Add tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
              />
              <button onClick={addTag} style={{ fontSize: 12, padding: '6px 10px' }}>Add</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={commit} style={{ fontSize: 12, padding: '6px 10px' }}>Save</button>
            <button onClick={cancel} style={{ fontSize: 12, padding: '6px 10px' }}>Cancel</button>
          </div>
        </div>
      ) : data.text ? (
        <div className="pt-body" style={{ fontSize: 12, lineHeight: 1.35 }} dangerouslySetInnerHTML={{ __html: data.text }} />
      ) : (
        <div style={{ fontSize: 13, color: '#6b7280' }}>Double‑click to edit…</div>
      )}

      {!editing && Array.isArray(data.tags) && data.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {data.tags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 9999 }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
};

const ImageNode = ({ id, data }) => {
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    src: data.src || '',
    title: data.title || '',
    description: data.description || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
  });
  const displaySrc = data.thumbnail || data.src || data.preview || '';
  const [tagInput, setTagInput] = React.useState('');

  const commit = React.useCallback(() => {
    setEditing(false);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...draft } } : n)));
  }, [draft, id, setNodes]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setDraft({
      src: data.src || '',
      title: data.title || '',
      description: data.description || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
    });
    setTagInput('');
  }, [data.src, data.title, data.description, data.tags]);

  const addTag = React.useCallback(() => {
    const t = tagInput.trim();
    if (!t) return;
    if (draft.tags.includes(t)) return;
    setDraft((d) => ({ ...d, tags: [...d.tags, t] }));
    setTagInput('');
  }, [tagInput, draft.tags]);

  const removeTag = (t) => setDraft((d) => ({ ...d, tags: d.tags.filter((x) => x !== t) }));

  const altFromData = (obj) => (obj.title || obj.description || '');

  return (
    <div
      className="pt-node pt-image"
      style={{
        padding: 8,
        borderRadius: 8,
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        background: '#fff',
        border: '1px solid',
        borderColor: data._searchMatch ? '#f97316' : '#e5e7eb',
        minWidth: 240,
        outline: data._isConnectSource ? '2px dashed #ef4444' : undefined,
        outlineOffset: 2,
      }}
      onDoubleClick={() => setEditing(true)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      {data.title && (
        <div style={{ fontWeight: 600, margin: '4px 0 6px', fontSize: 13 }}>{data.title}</div>
      )}

      {!editing && (
        displaySrc ? (
          <img src={displaySrc} alt={altFromData(data)} style={{ display: 'block', maxWidth: 260, borderRadius: 6 }} />
        ) : (
          <div style={{ width: 260, height: 140, borderRadius: 6, background: '#f3f4f6' }} />
        )
      )}

      {data.description && !editing && (
        <div style={{ fontSize: 11, color: '#4b5563', marginTop: 6, whiteSpace: 'pre-wrap' }}>{data.description}</div>
      )}

      {Array.isArray(data.tags) && data.tags.length > 0 && !editing && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {data.tags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 9999 }}>{t}</span>
          ))}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }} onBlur={(e) => {
          const rt = e.relatedTarget;
          if (!rt || !e.currentTarget.contains(rt)) commit();
        }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 4 }}>
            {draft.src ? (
              <img src={draft.src} alt={altFromData(draft)} style={{ display: 'block', maxWidth: 260, borderRadius: 4 }} />
            ) : (
              <div style={{ width: 260, height: 140, background: '#f3f4f6', borderRadius: 4 }} />
            )}
          </div>
          <input
            autoFocus
            placeholder="Image URL"
            value={draft.src}
            onChange={(e) => setDraft((d) => ({ ...d, src: e.target.value }))}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <input
            placeholder="Title (optional)"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <textarea
            placeholder="Description (optional)"
            rows={3}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {draft.tags.map((t) => (
                <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e0e7ff', borderRadius: 9999 }}>
                  {t}
                  <button title="Remove" onClick={() => removeTag(t)} style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, boxShadow: 'none' }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="Add tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                }}
                style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
              />
              <button onClick={addTag} style={{ fontSize: 12, padding: '6px 10px' }}>Add</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={commit} style={{ fontSize: 12, padding: '6px 10px' }}>Save</button>
            <button onClick={cancel} style={{ fontSize: 12, padding: '6px 10px' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

const LinkNode = ({ id, data }) => {
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    url: data.url || '',
    title: data.title || '',
    description: data.description || '',
    image: data.image || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
  });
  const [tagInput, setTagInput] = React.useState('');
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState(null);
  const fetchController = React.useRef(null);

  const commit = React.useCallback(() => {
    setEditing(false);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...draft } } : n)));
  }, [draft, id, setNodes]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setDraft({
      url: data.url || '',
      title: data.title || '',
      description: data.description || '',
      image: data.image || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
    });
    setTagInput('');
  }, [data.url, data.title, data.description, data.image, data.tags]);

  const addTag = React.useCallback(() => {
    const t = tagInput.trim();
    if (!t) return;
    if (draft.tags.includes(t)) return;
    setDraft((d) => ({ ...d, tags: [...d.tags, t] }));
    setTagInput('');
  }, [tagInput, draft.tags]);

  const removeTag = (t) => setDraft((d) => ({ ...d, tags: d.tags.filter((x) => x !== t) }));

  // Auto preview when URL changes (debounced)
  React.useEffect(() => {
    if (!editing) return;
    const url = normalizeUrl(draft.url);
    if (!url) {
      setPreviewError('Invalid URL');
      return;
    }
    setPreviewError(null);
    setPreviewLoading(true);
    if (fetchController.current) fetchController.current.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    const t = setTimeout(async () => {
      try {
        const preview = await fetchLinkPreview(url);
        setDraft((d) => ({
          ...d,
          url,
          title: preview.title || d.title || url,
          description: preview.description || d.description || '',
          image: preview.image || d.image || '',
          tags: d.tags || [],
        }));
        setPreviewLoading(false);
        setPreviewError(null);
      } catch (err) {
        setPreviewLoading(false);
        setPreviewError('Preview unavailable');
      }
    }, 400);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [draft.url, editing]);

  return (
    <div
      className="pt-node pt-link"
      style={{
        padding: 12,
        borderRadius: 8,
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        background: '#fff',
        border: '1px solid',
        borderColor: data._searchMatch ? '#f97316' : '#e5e7eb',
        minWidth: 180,
        maxWidth: 260,
        outline: data._isConnectSource ? '2px dashed #ef4444' : undefined,
        outlineOffset: 2,
      }}
      onDoubleClick={() => setEditing(true)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div style={{ fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <a href={data.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'none', fontSize: 13 }}>
          {data.title ?? data.url ?? 'Link'}
        </a>
      </div>
      {data.image && !editing && (
        <div style={{ marginBottom: 6 }}>
          <img src={data.image} alt={data.title || data.url} style={{ width: '100%', borderRadius: 6, maxHeight: 160, objectFit: 'cover' }} />
        </div>
      )}
      {data.description && !editing && (
        <div className="pt-desc" style={{ fontSize: 11, color: '#4b5563' }}>{data.description}</div>
      )}
      {Array.isArray(data.tags) && data.tags.length > 0 && !editing && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {data.tags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 9999 }}>{t}</span>
          ))}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }} onBlur={(e) => {
          const rt = e.relatedTarget;
          if (!rt || !e.currentTarget.contains(rt)) commit();
        }}>
          <input
            autoFocus
            placeholder="URL"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <div style={{ fontSize: 11, color: '#4b5563' }}>
            {previewLoading && <span>Loading preview…</span>}
            {previewError && <span style={{ color: '#b91c1c' }}>{previewError}</span>}
            {!previewLoading && !previewError && (draft.title || draft.description) && (
              <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                {draft.image && <img src={draft.image} alt={draft.title || draft.url} style={{ width: '100%', borderRadius: 4, maxHeight: 160, objectFit: 'cover' }} />}
                {draft.title && <div style={{ fontWeight: 600 }}>{draft.title}</div>}
                {draft.description && <div style={{ fontSize: 11 }}>{draft.description}</div>}
              </div>
            )}
          </div>
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {draft.tags.map((t) => (
                <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 9999, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>{t}</span>
                  <button title="Remove" onClick={() => removeTag(t)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: 0, boxShadow: 'none' }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="Add tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
              />
              <button onClick={addTag} style={{ fontSize: 12, padding: '6px 10px' }}>Add</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={commit} style={{ fontSize: 12, padding: '6px 10px' }}>Save</button>
            <button onClick={cancel} style={{ fontSize: 12, padding: '6px 10px' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

const nodeTypes = {
  text: TextNode,
  image: ImageNode,
  link: LinkNode,
};

const nodeDefaults = {
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};

const initialNodes = [];
const initialEdges = [];

const OverlayToolbar = ({
  nodes,
  edges,
  setNodes,
  setEdges,
  mode,
  setMode,
  connectFrom,
  setConnectFrom,
  contextMenusEnabled,
  setContextMenusEnabled,
  onImageChosen,
  searchTerm = "",
  searchMatchesCount = 0,
  onSearchChange = () => {},
  hideNonMatches = false,
  onToggleHide = () => {},
  isSearching = false,
  offsetLeft = 10,
  shareAvailable = false,
}) => {
  const jsonRef = useRef(null);
  const imageRef = useRef(null);
  const { screenToFlowPosition } = useReactFlow();

  // --- Icons (inline SVG) & button style ---
  const ico = {
    export: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M12 16V4"/>
        <path d="M8 8l4-4 4 4"/>
        <rect x="3" y="16" width="18" height="4" rx="1"/>
      </svg>
    ),
    import: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M12 8v12"/>
        <path d="M8 12l4 4 4-4"/>
        <rect x="3" y="4" width="18" height="4" rx="1"/>
      </svg>
    ),
    cursor: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M3 3l7 18 2-7 7-2L3 3z"/>
      </svg>
    ),
    link: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"/>
        <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"/>
      </svg>
    ),
    menu: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" {...p}>
        <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
      </svg>
    ),
    trash: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M3 6h18"/>
        <path d="M8 6V4h8v2"/>
        <rect x="6" y="6" width="12" height="14" rx="1"/>
      </svg>
    ),
    grid: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
      </svg>
    ),
    flow: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M4 8c4 0 4 8 8 8h4"/>
        <path d="M16 12l4 4-4 4"/>
      </svg>
    ),
    text: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M6 6h12"/>
        <path d="M12 6v12"/>
      </svg>
    ),
    image: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <rect x="3" y="5" width="18" height="14" rx="2"/>
        <circle cx="8" cy="10" r="2"/>
        <path d="M21 17l-5-5-4 4-2-2-5 5"/>
      </svg>
    ),
    linkPlus: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"/>
        <path d="M19 7h4"/>
        <path d="M21 5v4"/>
      </svg>
    ),
    connect: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <circle cx="6" cy="12" r="2"/>
        <circle cx="18" cy="12" r="2"/>
        <path d="M8 12h8"/>
      </svg>
    ),
    context: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <rect x="3" y="4" width="14" height="12" rx="2"/>
        <path d="M6 8h8"/>
        <path d="M6 12h8"/>
        <path d="M6 16h6"/>
      </svg>
    ),
    share: (p) => (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186" />
        <path d="M7.217 10.907c.18.324.283.696.283 1.093s-.103.77-.283 1.093" />
        <path d="M7.217 10.907 16.783 5.593" />
        <path d="M7.217 13.093l9.566 5.314" />
        <path d="M16.783 18.407a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Z" />
        <path d="M16.783 5.593a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
      </svg>
    ),
    linkAdd: (p) => (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757"/>
        <path d="M19.297 8.066l1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/>
      </svg>
    )
  };

  const searchInputId = "papertrail-search-input";
  const matchesLabel = searchTerm
    ? searchMatchesCount > 0
      ? `${searchMatchesCount} match${searchMatchesCount === 1 ? "" : "es"}`
      : "No matches"
    : "";

  const btnStyle = (active = false, disabled = false) => ({
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    background: active ? '#eef2ff' : '#fff',
    opacity: disabled ? 0.5 : 1,
    padding: 0,
    cursor: disabled ? 'default' : 'pointer'
  });

  const doExport = () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), nodes, edges };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'papertrail-board.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onImport = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
          setNodes(data.nodes);
          setEdges(data.edges);
        } else {
          console.error('Invalid board file: expected {nodes, edges}.');
        }
      } catch (err) {
        console.error('Failed to parse JSON:', err);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  // (replaced by btnStyle)

  const centerPos = () => {
    const el = document.querySelector('.react-flow');
    const rect = el?.getBoundingClientRect();
    const x = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
    const y = (rect?.top ?? 0) + 120; // slight downward offset
    return screenToFlowPosition({ x, y });
  };

  const addNode = (type, data = {}) => {
    const id = String(Date.now());
    const pos = centerPos();
    const base = { id, type, position: pos, data, sourcePosition: Position.Right, targetPosition: Position.Left };
    setNodes((ns) => ns.concat(base));
  };

  const addText = () => addNode('text', { title: '', text: '', tags: [] });

  const addLink = () => {
    const raw = window.prompt('Link URL');
    const url = normalizeUrl(raw);
    if (!url) { window.alert('Invalid URL'); return; }
    const id = String(Date.now());
    const pos = centerPos();
    const base = { id, type: 'link', position: pos, data: { url, title: url, description: '', image: '', tags: [] }, sourcePosition: Position.Right, targetPosition: Position.Left };
    setNodes((ns) => ns.concat(base));
    fetchLinkPreview(url).then((preview) => {
      setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, title: preview.title || url, description: preview.description || '', image: preview.image || '' } } : n));
    }).catch(() => {});
  };

  const triggerImageUpload = () => imageRef.current && imageRef.current.click();

  // Selection helpers and deletion
  const selectedNodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
  const selectedEdgeIds = edges.filter((e) => e.selected).map((e) => e.id);
  const hasSelection = selectedNodeIds.length > 0 || selectedEdgeIds.length > 0;

  const doDelete = () => {
    const nodeIdsToDelete = selectedNodeIds;
    const nextNodes = nodes.filter((n) => !n.selected && !nodeIdsToDelete.includes(n.id));
    const nextEdges = edges.filter(
      (e) => !e.selected && !nodeIdsToDelete.includes(e.source) && !nodeIdsToDelete.includes(e.target)
    );
    setNodes(nextNodes);
    setEdges(nextEdges);
  };

  // --- Auto layout helpers ---
  const autoGrid = React.useCallback(() => {
    const pad = 80;
    const gapX = 520; // accommodate wider/preview-heavy nodes
    const gapY = 420; // larger vertical spacing to reduce overlap
    const count = nodes.length;
    if (!count) return;
    const cols = Math.ceil(Math.sqrt(count));
    setNodes((ns) => ns.map((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return { ...n, position: { x: pad + col * gapX, y: pad + row * gapY } };
    }));
  }, [nodes, setNodes]);

  const autoFlowLR = React.useCallback(() => {
    const pad = 80;
    const gapX = 520; // wider spacing for preview-heavy nodes
    const gapY = 400;
    const ids = nodes.map((n) => n.id);
    const idSet = new Set(ids);
    const inDeg = {};
    const out = {};
    ids.forEach((id) => { inDeg[id] = 0; out[id] = []; });
    edges.forEach((e) => {
      if (!idSet.has(e.source) || !idSet.has(e.target)) return;
      out[e.source].push(e.target);
      inDeg[e.target] = (inDeg[e.target] || 0) + 1;
    });
    const pending = new Set(ids);
    const layers = [];
    let queue = ids.filter((id) => !inDeg[id]);
    while (pending.size) {
      if (queue.length === 0) {
        // cycle fallback: pick any remaining node
        queue = [pending.values().next().value];
      }
      const thisLayer = [];
      const nextQueue = [];
      for (const id of queue) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        thisLayer.push(id);
        for (const v of out[id]) {
          inDeg[v] = (inDeg[v] || 0) - 1;
          if (inDeg[v] === 0) nextQueue.push(v);
        }
      }
      layers.push(thisLayer);
      queue = nextQueue;
    }
    const positions = {};
    layers.forEach((arr, L) => {
      arr.forEach((id, idx) => {
        positions[id] = { x: pad + L * gapX, y: pad + idx * gapY };
      });
    });
    setNodes((ns) => ns.map((n) => positions[n.id] ? { ...n, position: positions[n.id] } : n));
  }, [nodes, edges, setNodes]);

  return (
    <div style={{ position: 'absolute', top: 10, left: offsetLeft ?? 10, zIndex: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
      <button onClick={doExport} style={btnStyle()} title="Export" aria-label="Export">{ico.export()}</button>
      <button onClick={() => jsonRef.current && jsonRef.current.click()} style={btnStyle()} title="Import" aria-label="Import">{ico.import()}</button>
      <input ref={jsonRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={onImport} />
      <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
      <button aria-pressed={mode === 'select'} onClick={() => { setConnectFrom(null); setMode('select'); setNodes((ns)=>ns.map(n=> ({...n, data:{...n.data, _isConnectSource:false}}))); }} style={btnStyle(mode === 'select')} title="Select mode" aria-label="Select mode">{ico.cursor()}</button>
      <button aria-pressed={mode === 'connect'} onClick={() => setMode('connect')} style={btnStyle(mode === 'connect')} title="Connect mode" aria-label="Connect mode">{ico.connect()}</button>
      {mode === 'connect' && (
        <span style={{ fontSize: 12, color: '#374151' }}>{connectFrom ? `from: ${connectFrom}` : 'pick a source node'}</span>
      )}
      <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
      <button aria-pressed={contextMenusEnabled} onClick={() => setContextMenusEnabled((v) => !v)} title="Toggle right-click context menus" aria-label="Toggle context menus" style={btnStyle(contextMenusEnabled)}>{ico.context()}</button>
      <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
      <button onClick={doDelete} disabled={!hasSelection} title="Delete selected (Del/Backspace)" aria-label="Delete selected" style={btnStyle(false, !hasSelection)}>{ico.trash()}</button>
      <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
      <button onClick={autoGrid} title="Auto layout: Grid" aria-label="Auto Grid" style={btnStyle()}>{ico.grid()}</button>
      <button onClick={autoFlowLR} title="Auto layout: Left→Right" aria-label="Auto Flow" style={btnStyle()}>{ico.flow()}</button>
      <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
      <button onClick={addText} style={btnStyle()} title="Add text node" aria-label="Add text node">{ico.text()}</button>
      <button onClick={triggerImageUpload} style={btnStyle()} title="Upload image node" aria-label="Upload image node">{ico.image()}</button>
      <input ref={imageRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onImageChosen} />
      <button onClick={addLink} style={btnStyle()} title="Add link node" aria-label="Add link node">{ico.linkAdd()}</button>
      {shareAvailable && (
        <>
          <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' }} />
          <button
            type="button"
            data-modal-open="share-project"
            data-share-trigger
            title="Share"
            aria-label="Share"
            style={btnStyle()}
          >
            {ico.share()}
          </button>
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb' }}>
        <input
          id={searchInputId}
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search board…"
          style={{
            border: 'none',
            outline: 'none',
            width: 140,
            fontSize: 11,
            background: 'transparent',
            height: 24,
          }}
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 12,
              color: '#6b7280',
              padding: '0 4px',
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
        <button
          type="button"
          onClick={onToggleHide}
          aria-pressed={hideNonMatches}
          disabled={!isSearching}
          style={{
            border: '1px solid',
            borderColor: hideNonMatches ? '#ea580c' : '#cbd5f5',
            borderRadius: 6,
            padding: '2px 8px',
            fontSize: 11,
            background: hideNonMatches ? '#fef3c7' : '#fff',
            cursor: isSearching ? 'pointer' : 'not-allowed',
          }}
        >
          {hideNonMatches ? "Show all" : "Matches only"}
        </button>
        {matchesLabel && (
          <span style={{ fontSize: 11, color: '#475569' }}>{matchesLabel}</span>
        )}
      </div>
    </div>
  );
};

const DropReceiver = ({ onImageFile = () => {} }) => {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = React.useCallback((e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = React.useCallback((e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = Array.from(files).find((f) => f.type && f.type.startsWith('image/')) || files[0];
    if (!file) return;
    const { clientX, clientY } = e;
    const pos = screenToFlowPosition({ x: clientX, y: clientY });
    onImageFile(file, pos);
  }, [screenToFlowPosition, onImageFile]);

  const onPaste = React.useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const item = Array.from(items).find((it) => it.type && it.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    // center of the viewport
    const el = document.querySelector('.react-flow');
    const rect = el?.getBoundingClientRect();
    const x = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
    const y = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
    const pos = screenToFlowPosition({ x, y });
    onImageFile(file, pos);
  }, [screenToFlowPosition, onImageFile]);

  React.useEffect(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (pane) {
      pane.addEventListener('dragover', onDragOver);
      pane.addEventListener('drop', onDrop);
    }
    window.addEventListener('paste', onPaste);
    return () => {
      if (pane) {
        pane.removeEventListener('dragover', onDragOver);
        pane.removeEventListener('drop', onDrop);
      }
      window.removeEventListener('paste', onPaste);
    };
  }, [onDragOver, onDrop, onPaste]);

  return null;
};

const Flow = () => {
  const projectId = React.useMemo(() => {
    const m = window.location.pathname.match(/\/papertrail\/([^/]+)/);
    if (m && m[1]) return decodeURIComponent(m[1]);
    const params = new URLSearchParams(window.location.search);
    return params.get('projectId') || 'papertrail-default';
  }, []);
  const shareAvailable = React.useMemo(() => {
    const root = document.getElementById('plugin-root');
    if (!root) return false;
    const flag = root.getAttribute('data-share-can-view');
    return String(flag).toLowerCase() === 'true';
  }, []);

  const [searchTerm, setSearchTerm] = React.useState("");
  const normalizedSearchTerm = React.useMemo(() => searchTerm.trim().toLowerCase(), [searchTerm]);
  const isSearching = normalizedSearchTerm.length > 0;
  const [hideNonMatches, setHideNonMatches] = React.useState(false);

  React.useEffect(() => {
    if (!isSearching && hideNonMatches) {
      setHideNonMatches(false);
    }
  }, [isSearching, hideNonMatches]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [loading, setLoading] = React.useState(true);
  const saverRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const clientIdRef = React.useRef(`${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const boardVersionRef = React.useRef(null);
  const pendingUpdatesRef = React.useRef([]);
  const reconnectTimerRef = React.useRef(null);
  const [wsRetryToken, setWsRetryToken] = React.useState(0);

  const nodeSearchMatches = React.useMemo(() => {
    if (!isSearching) return new Set();
    const matches = new Set();
    nodes.forEach((node) => {
      const data = node.data || {};
      const haystack = [
        data.title,
        data.text,
        data.description,
        data.url,
        Array.isArray(data.tags) ? data.tags.join(" ") : "",
      ];
      if (haystack.some((value) => matchesSearch(value, normalizedSearchTerm))) {
        matches.add(node.id);
      }
    });
    return matches;
  }, [nodes, normalizedSearchTerm, isSearching]);

  const edgeSearchMatches = React.useMemo(() => {
    if (!isSearching) return new Set();
    const matches = new Set();
    edges.forEach((edge) => {
      const haystack = [edge.label, edge.data?.label, edge.data?.description, edge.data?.text];
      if (haystack.some((value) => matchesSearch(value, normalizedSearchTerm))) {
        matches.add(edge.id);
      }
    });
    return matches;
  }, [edges, normalizedSearchTerm, isSearching]);

  const decoratedNodes = React.useMemo(() => {
    if (!isSearching) return nodes;
    return nodes.map((node) =>
      nodeSearchMatches.has(node.id)
        ? { ...node, data: { ...(node.data || {}), _searchMatch: true } }
        : node
    );
  }, [nodes, isSearching, nodeSearchMatches]);

  const decoratedEdges = React.useMemo(() => {
    if (!isSearching) return edges;
    return edges.map((edge) =>
      edgeSearchMatches.has(edge.id)
        ? {
            ...edge,
            className: edge.className
              ? `${edge.className} ${SEARCH_EDGE_CLASS}`.trim()
              : SEARCH_EDGE_CLASS,
            data: { ...(edge.data || {}), _searchMatch: true },
          }
        : edge
    );
  }, [edges, isSearching, edgeSearchMatches]);

  const visibleNodes = React.useMemo(() => {
    if (hideNonMatches && isSearching) {
      return decoratedNodes.filter((node) => node.data && node.data._searchMatch);
    }
    return decoratedNodes;
  }, [decoratedNodes, hideNonMatches, isSearching]);

  const visibleEdges = React.useMemo(() => {
    if (hideNonMatches && isSearching) {
      return decoratedEdges.filter((edge) => edge.data && edge.data._searchMatch);
    }
    return decoratedEdges;
  }, [decoratedEdges, hideNonMatches, isSearching]);

  const totalSearchMatches = React.useMemo(
    () => nodeSearchMatches.size + edgeSearchMatches.size,
    [nodeSearchMatches, edgeSearchMatches]
  );

  const handleNodesChange = React.useCallback(
    (changes) => {
      const sanitized = (changes || []).map(sanitizeNodeChange);
      onNodesChange(sanitized);
    },
    [onNodesChange]
  );

  const handleEdgesChange = React.useCallback(
    (changes) => {
      const sanitized = (changes || []).map(sanitizeEdgeChange);
      onEdgesChange(sanitized);
    },
    [onEdgesChange]
  );

  const handleSearchChange = React.useCallback((value) => {
    setSearchTerm(value || "");
  }, []);

  const sendRealtimeUpdate = React.useCallback(
    (snapshot) => {
      if (!snapshot || !snapshot.version) return;
      boardVersionRef.current = snapshot.version;
      const ws = wsRef.current;
      const payload = {
        projectId,
        version: snapshot.version,
        sourceId: clientIdRef.current,
        snapshot,
      };
      const packet = JSON.stringify({ type: "pt:update", payload });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(packet);
        return;
      }
      pendingUpdatesRef.current.push(packet);
    },
    [projectId]
  );

  const applyRemoteSnapshot = React.useCallback(
    async (snapshot) => {
      if (!snapshot) return;
      const nextNodes = snapshot.nodes || [];
      const nextEdges = snapshot.edges || [];
      if (boardVersionRef.current && snapshot.version <= boardVersionRef.current) return;
      setNodes(nextNodes);
      setEdges(nextEdges);
      saverRef.current?.setVersion(snapshot.version);
      boardVersionRef.current = snapshot.version;
      try {
        await saveCache(projectId, { ...snapshot, cachedAt: new Date().toISOString() });
      } catch {
        // ignore cache failures
      }
    },
    [projectId, setNodes, setEdges]
  );

  const handleWsPacket = React.useCallback(
    async (event) => {
    const packet = safeJsonParse(event.data);
    if (!packet || packet.type !== "pt:update") return;
    const { projectId: payloadProjectId, version, sourceId, snapshot } = packet.payload || {};
    if (payloadProjectId !== projectId) return;
    if (!version) return;
    if (sourceId === clientIdRef.current) return;
    if (boardVersionRef.current && boardVersionRef.current === version) return;
    if (!snapshot) {
      try {
        const remote = await fetchBoard(projectId);
        await applyRemoteSnapshot(remote);
        setConflictNotice("Remote changes applied.");
      } catch (err) {
        console.warn("[papertrail] failed to apply realtime update", err);
      }
      return;
    }
    await applyRemoteSnapshot(snapshot);
    setConflictNotice("Remote changes applied.");
  },
    [projectId, applyRemoteSnapshot]
  );

  const scheduleReconnect = React.useCallback(() => {
    if (reconnectTimerRef.current) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setWsRetryToken((token) => token + 1);
    }, 3000);
  }, []);

  React.useEffect(() => {
    if (!projectId) return undefined;
    const wsUrl = makeWsUrl();
    if (!wsUrl) return undefined;
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;
    const handleOpen = () => {
      socket.send(
        JSON.stringify({
          type: "pt:join",
          payload: { projectId },
        })
      );
      const pending = pendingUpdatesRef.current;
      pendingUpdatesRef.current = [];
      for (const payload of pending) {
        socket.send(payload);
      }
    };
    const handleClose = () => {
      wsRef.current = null;
      scheduleReconnect();
    };
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleWsPacket);
    socket.addEventListener("error", (err) => {
      console.warn("[papertrail] realtime connection error", err);
    });
    socket.addEventListener("close", handleClose);
    return () => {
      socket.close();
      wsRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [projectId, handleWsPacket, wsRetryToken, scheduleReconnect]);

  const toggleHideNonMatches = React.useCallback(() => {
    setHideNonMatches((prev) => !prev);
  }, []);

  const handleImageFile = React.useCallback(
    async (file, position = { x: 0, y: 0 }) => {
      if (!file) return;
      let preview = '';
      try {
        preview = await createImagePreview(file);
      } catch (err) {
        console.warn('[papertrail] failed to create image preview', err);
      }
      const id = String(Date.now());
      const node = {
        id,
        type: 'image',
        position: position || { x: 0, y: 0 },
        data: { src: preview, preview, title: '', description: '', tags: [] },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
      setNodes((ns) => ns.concat(node));
      try {
        const uploaded = await uploadImageFile(file, projectId);
        if (uploaded?.url) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      src: uploaded.url,
                      preview: n.data.preview || preview,
                      thumbnail: uploaded.thumbnailUrl || n.data.thumbnail,
                    },
                  }
                : n
            )
          );
        }
      } catch (err) {
        console.error('[papertrail] image upload failed', err);
      }
    },
    [projectId, setNodes]
  );

  const onImageChosen = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    handleImageFile(file);
    e.target.value = '';
  };

  const [mode, setMode] = React.useState('select');
  const [connectFrom, setConnectFrom] = React.useState(null);
  const [menu, setMenu] = React.useState(null); // { left, top, type: 'node'|'edge', id, source?, target? }
  const [edgeEditor, setEdgeEditor] = React.useState(null); // { id, left, top, label, color, width, type, animated, dashed }
  const [contextMenusEnabled, setContextMenusEnabled] = React.useState(true);
  const [conflictNotice, setConflictNotice] = React.useState(null);

  const defaultEdgeOptions = React.useMemo(() => ({
    labelStyle: { fontSize: 11, fill: '#334155' },
  }), []);

  const deleteNodeById = React.useCallback((nodeId) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
  }, [setNodes, setEdges]);

  const deleteEdgeByRef = React.useCallback((edgeId, source, target) => {
    setEdges((eds) => eds.filter((e) => {
      if (e.id && edgeId) return e.id !== edgeId;
      // fallback by endpoints
      return !(e.source === source && e.target === target);
    }));
  }, [setEdges]);

  // Offline-first hydrate + sync
  React.useEffect(() => {
    let cancelled = false;
    const saver = createSaver({
      projectId,
      onConflict: async (err) => {
        try {
          const remote = await fetchBoard(projectId);
          if (cancelled) return;
          await applyRemoteSnapshot(remote);
          setConflictNotice('Remote changes detected; reloaded server version.');
        } catch {
          setConflictNotice('Version conflict; failed to fetch latest.');
        }
      },
        onSuccess: (res) => {
          sendRealtimeUpdate(res);
        },
    });
    saverRef.current = saver;

    const hydrate = async () => {
      let hadCachedSnapshot = false;
      const cached = await loadCache(projectId);
      if (cached && !cancelled) {
        hadCachedSnapshot = true;
        setNodes(cached.nodes || []);
        setEdges(cached.edges || []);
        saver.setVersion(cached.version);
        boardVersionRef.current = cached.version;
      }
      try {
        const remote = await fetchBoard(projectId);
        if (cancelled) return;
        await applyRemoteSnapshot(remote);
      } catch (err) {
        if (err?.status === 404) {
          if (hadCachedSnapshot) {
            setConflictNotice("Remote board missing; showing cached version.");
          } else {
            try {
              const created = await createBoard(projectId, { nodes: initialNodes, edges: initialEdges });
              if (cancelled) return;
              await applyRemoteSnapshot(created);
            } catch (createErr) {
              console.error("[papertrail] failed to create board:", createErr);
            }
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    hydrate();

    const offOnline = onOnline(() => {
      saver.forceFlush();
    });
    return () => {
      cancelled = true;
      offOnline();
    };
  }, [projectId, setNodes, setEdges]);

  // Schedule save on state changes (debounced)
  React.useEffect(() => {
    if (loading) return;
    const snapshot = {
      board: { id: projectId },
      nodes,
      edges,
    };
    saveCache(projectId, { ...snapshot, version: null, cachedAt: new Date().toISOString() });
    saverRef.current?.schedule(snapshot);
  }, [projectId, nodes, edges, loading]);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setConnectFrom(null);
        setMode('select');
        setMenu(null);
        setEdgeEditor(null);
        setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, _isConnectSource: false } })));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const t = e.target;
        const isEditable = t && ((t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) || t.isContentEditable);
        if (isEditable) return; // don't hijack while typing
        e.preventDefault();
        // Remove selected nodes and edges; also drop edges connected to removed nodes
        setNodes((ns) => {
          const removeIds = ns.filter((n) => n.selected).map((n) => n.id);
          const nextNodes = ns.filter((n) => !n.selected);
          setEdges((eds) => eds.filter((ed) => !ed.selected && !removeIds.includes(ed.source) && !removeIds.includes(ed.target)));
          return nextNodes;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setNodes, setEdges, setMode, setConnectFrom]);

  const onConnect = useCallback(
    (params) => setEdges((els) => addEdge(params, els)),
    [],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {conflictNotice && (
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 50, background: '#fef9c3', border: '1px solid #facc15', color: '#854d0e', padding: '6px 10px', borderRadius: 6 }}>
          {conflictNotice}
          <button onClick={() => setConflictNotice(null)} style={{ marginLeft: 10, border: 'none', background: 'transparent', cursor: 'pointer', color: '#854d0e' }}>×</button>
        </div>
      )}
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeClick={(e, node) => {
          if (mode !== 'connect') return;
          e.preventDefault();
          e.stopPropagation();
          if (!connectFrom) {
            setConnectFrom(node.id);
            setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, data: { ...n.data, _isConnectSource: true } } : { ...n, data: { ...n.data, _isConnectSource: false } }));
          } else if (connectFrom !== node.id) {
            setEdges((eds) => addEdge({ source: connectFrom, target: node.id }, eds));
            setConnectFrom(null);
            setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, _isConnectSource: false } })));
          }
        }}
        onPaneClick={() => {
          setMenu(null);
          setEdgeEditor(null);
          if (mode === 'connect') {
            setConnectFrom(null);
            setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, _isConnectSource: false } })));
          }
        }}
        onNodeContextMenu={(e, node) => {
          if (!contextMenusEnabled) return;
          e.preventDefault();
          const rfRect = document.querySelector('.react-flow')?.getBoundingClientRect();
          const left = e.clientX - (rfRect?.left ?? 0);
          const top = e.clientY - (rfRect?.top ?? 0);
          setMenu({ left, top, type: 'node', id: node.id });
        }}
        onEdgeContextMenu={(e, edge) => {
          if (!contextMenusEnabled) return;
          e.preventDefault();
          const rfRect = document.querySelector('.react-flow')?.getBoundingClientRect();
          const left = e.clientX - (rfRect?.left ?? 0);
          const top = e.clientY - (rfRect?.top ?? 0);
          setMenu({ left, top, type: 'edge', id: edge.id, source: edge.source, target: edge.target });
        }}
        onEdgeDoubleClick={(e, edge) => {
          e.preventDefault();
          const rfRect = document.querySelector('.react-flow')?.getBoundingClientRect();
          const left = e.clientX - (rfRect?.left ?? 0);
          const top = e.clientY - (rfRect?.top ?? 0);
          const currentColor = (edge.style && edge.style.stroke) || '#64748b';
          const currentWidth = (edge.style && edge.style.strokeWidth) ? Number(edge.style.strokeWidth) : 1;
          const currentDashed = !!(edge.style && edge.style.strokeDasharray);
          setEdgeEditor({
            id: edge.id,
            left,
            top,
            label: edge.label || '',
            color: currentColor,
            width: currentWidth,
            type: edge.type || 'default',
            animated: !!edge.animated,
            dashed: currentDashed,
          });
          setMenu(null);
        }}
        nodeTypes={nodeTypes}
        fitView
        defaultEdgeOptions={defaultEdgeOptions}
      >
        {/* Minimal overlay toolbar (client-only) */}
        <OverlayToolbar
          nodes={nodes}
          edges={edges}
          setNodes={setNodes}
          setEdges={setEdges}
          mode={mode}
          setMode={setMode}
          connectFrom={connectFrom}
          setConnectFrom={setConnectFrom}
          contextMenusEnabled={contextMenusEnabled}
          setContextMenusEnabled={setContextMenusEnabled}
          onImageChosen={onImageChosen}
          searchTerm={searchTerm}
          searchMatchesCount={isSearching ? totalSearchMatches : 0}
          onSearchChange={handleSearchChange}
          hideNonMatches={hideNonMatches}
          onToggleHide={toggleHideNonMatches}
          isSearching={isSearching}
          shareAvailable={shareAvailable}
        />
        <DropReceiver onImageFile={handleImageFile} />
        {menu && (
          <div
            style={{ position: 'absolute', left: menu.left, top: menu.top, zIndex: 40 }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 4, minWidth: 140 }}>
              {menu.type === 'node' ? (
                <button
                  style={{ width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onClick={() => { deleteNodeById(menu.id); setMenu(null); }}
                >
                  Delete node
                </button>
              ) : (
                <div style={{ display: 'grid' }}>
                  <button
                    style={{ width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', cursor: 'pointer' }}
                    onClick={() => {
                      const edge = edges.find((e) => e.id === menu.id) || { style: {} };
                      const currentColor = (edge.style && edge.style.stroke) || '#64748b';
                      const currentWidth = (edge.style && edge.style.strokeWidth) ? Number(edge.style.strokeWidth) : 1;
                      const currentDashed = !!(edge.style && edge.style.strokeDasharray);
                      setEdgeEditor({
                        id: edge.id || menu.id,
                        left: menu.left + 8,
                        top: menu.top + 8,
                        label: edge.label || '',
                        color: currentColor,
                        width: currentWidth,
                        type: edge.type || 'default',
                        animated: !!edge.animated,
                        dashed: currentDashed,
                      });
                      setMenu(null);
                    }}
                  >
                    Edit edge…
                  </button>
                  <button
                    style={{ width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', cursor: 'pointer' }}
                    onClick={() => { deleteEdgeByRef(menu.id, menu.source, menu.target); setMenu(null); }}
                  >
                    Delete edge
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {isSearching && (
          <style>
            {`
              .react-flow__edge.${SEARCH_EDGE_CLASS} path {
                stroke: #f97316 !important;
                stroke-width: 3px !important;
                filter: drop-shadow(0 0 5px rgba(249, 115, 22, 0.75));
              }
            `}
          </style>
        )}
        {edgeEditor && (
          <div
            style={{ position: 'absolute', left: edgeEditor.left, top: edgeEditor.top, zIndex: 50 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 10, minWidth: 240 }}>
              <div style={{ display: 'grid', gap: 6 }}>
                <label style={{ fontSize: 12, color: '#334155' }}>
                  Label
                  <input
                    value={edgeEditor.label}
                    onChange={(e) => setEdgeEditor((ed) => ({ ...ed, label: e.target.value }))}
                    style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
                  />
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Color
                    <input type="color" value={edgeEditor.color} onChange={(e) => setEdgeEditor((ed) => ({ ...ed, color: e.target.value }))} />
                  </label>
                  <label style={{ fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Width
                    <input type="number" min="1" max="8" value={edgeEditor.width} onChange={(e) => setEdgeEditor((ed) => ({ ...ed, width: Number(e.target.value) }))} style={{ width: 60, padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 4 }} />
                  </label>
                </div>
                <label style={{ fontSize: 12, color: '#334155' }}>
                  Type
                  <select value={edgeEditor.type} onChange={(e) => setEdgeEditor((ed) => ({ ...ed, type: e.target.value }))} style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}>
                    <option value="default">Curved (default)</option>
                    <option value="straight">Straight</option>
                    <option value="step">Elbow</option>
                    <option value="smoothstep">Smoothstep</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: '#334155', display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span><input type="checkbox" checked={edgeEditor.animated} onChange={(e) => setEdgeEditor((ed) => ({ ...ed, animated: e.target.checked }))} /> Animated</span>
                  <span><input type="checkbox" checked={edgeEditor.dashed} onChange={(e) => setEdgeEditor((ed) => ({ ...ed, dashed: e.target.checked }))} /> Dashed</span>
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                  <button onClick={() => setEdgeEditor(null)} style={{ fontSize: 12, padding: '6px 10px' }}>Cancel</button>
                  <button
                    onClick={() => {
                      setEdges((eds) => eds.map((e) => e.id === edgeEditor.id ? {
                        ...e,
                        type: edgeEditor.type,
                        animated: edgeEditor.animated,
                        label: edgeEditor.label && edgeEditor.label.trim() ? edgeEditor.label.trim() : undefined,
                        labelStyle: edgeEditor.label && edgeEditor.label.trim() ? { fontSize: 11, fill: '#334155' } : undefined,
                        style: {
                          ...(e.style || {}),
                          stroke: edgeEditor.color,
                          strokeWidth: Number(edgeEditor.width) || 2,
                          ...(edgeEditor.dashed ? { strokeDasharray: '6 3' } : { strokeDasharray: undefined }),
                        },
                      } : e));
                      setEdgeEditor(null);
                    }}
                    style={{ fontSize: 12, padding: '6px 10px' }}
                  >Apply</button>
                </div>
              </div>
            </div>
          </div>
        )}
        {mode === 'connect' && (
          <style>
            {`
            .react-flow__handle { background: #ef4444 !important; box-shadow: 0 0 0 4px rgba(239,68,68,0.18); }
            .react-flow__node { cursor: crosshair; }
            `}
          </style>
        )}
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
};

export default Flow;
