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
import { ensureXYFlowStyles } from './xyflowStyles.js';
ensureXYFlowStyles();

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
      style={{ padding: 12, borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', background: '#fff', border: '1px solid #e5e7eb', minWidth: 160, outline: data._isConnectSource ? '2px dashed #ef4444' : undefined, outlineOffset: 2 }}
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
                <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#eef2ff', border: '1px solid #e0e7ff', borderRadius: 9999 }}>
                  {t}
                  <button title="Remove" onClick={() => removeTag(t)} style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer' }}>×</button>
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
      style={{ padding: 8, borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', background: '#fff', border: '1px solid #e5e7eb', minWidth: 240, outline: data._isConnectSource ? '2px dashed #ef4444' : undefined, outlineOffset: 2 }}
      onDoubleClick={() => setEditing(true)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      {data.title && (
        <div style={{ fontWeight: 600, margin: '4px 0 6px', fontSize: 13 }}>{data.title}</div>
      )}

      {!editing && (
        data.src ? (
          <img src={data.src} alt={altFromData(data)} style={{ display: 'block', maxWidth: 260, borderRadius: 6 }} />
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
                <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: '#eef2ff', border: '1px solid #e0e7ff', borderRadius: 9999 }}>
                  {t}
                  <button title="Remove" onClick={() => removeTag(t)} style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer' }}>×</button>
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
  const [draft, setDraft] = React.useState({ url: data.url || '', title: data.title || '', description: data.description || '' });

  const commit = React.useCallback(() => {
    setEditing(false);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...draft } } : n)));
  }, [draft, id, setNodes]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setDraft({ url: data.url || '', title: data.title || '', description: data.description || '' });
  }, [data.url, data.title, data.description]);

  return (
    <div
      className="pt-node pt-link"
      style={{ padding: 12, borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', background: '#fff', border: '1px solid #e5e7eb', minWidth: 180, maxWidth: 260, outline: data._isConnectSource ? '2px dashed #ef4444' : undefined, outlineOffset: 2 }}
      onDoubleClick={() => setEditing(true)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <div style={{ fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <a href={data.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'none', fontSize: 13 }}>
          {data.title ?? data.url ?? 'Link'}
        </a>
      </div>
      {data.description && (
        <div className="pt-desc" style={{ fontSize: 11, color: '#4b5563' }}>{data.description}</div>
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
          <input
            placeholder="Title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
          <textarea
            placeholder="Description"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            rows={3}
            style={{ fontSize: 11, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 4 }}
          />
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

const initialNodes = [
  {
    id: '1',
    type: 'text',
    position: { x: 0, y: 150 },
    data: { title: '', text: '' },
    ...nodeDefaults,
  },
  {
    id: '2',
    type: 'image',
    position: { x: 300, y: 0 },
    data: { src: 'https://picsum.photos/260/140', title: 'Image', description: 'default style 2 — Image node', tags: ['sample'] },
    ...nodeDefaults,
  },
  {
    id: '3',
    type: 'link',
    position: { x: 300, y: 200 },
    data: { url: 'https://example.com', title: 'Example.com', description: 'default style 3 — Link node' },
    ...nodeDefaults,
  },
];

const initialEdges = [
  { id: 'e1-2', source: '1', target: '2', animated: true },
  { id: 'e1-3', source: '1', target: '3' },
];

const OverlayToolbar = ({ nodes, edges, setNodes, setEdges, mode, setMode, connectFrom, setConnectFrom, contextMenusEnabled, setContextMenusEnabled }) => {
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
    linkAdd: (p) => (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757"/>
        <path d="M19.297 8.066l1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/>
      </svg>
    )
  };

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
    const url = window.prompt('Link URL');
    if (!url) return;
    const title = window.prompt('Title (optional)') || url;
    addNode('link', { url, title, description: '' });
  };

  const triggerImageUpload = () => imageRef.current && imageRef.current.click();

  const onImageChosen = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      addNode('image', { src: reader.result, title: '', description: '', tags: [] });
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  };

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
    const pad = 40;
    const gapX = 260;
    const gapY = 160;
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
    const pad = 40;
    const gapX = 280;
    const gapY = 160;
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
    <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
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
    </div>
  );
};

const DropReceiver = ({ setNodes }) => {
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
    const reader = new FileReader();
    reader.onload = () => {
      const id = String(Date.now());
      const node = {
        id,
        type: 'image',
        position: pos,
        data: { src: reader.result, title: '', description: '', tags: [] },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
      setNodes((ns) => ns.concat(node));
    };
    reader.readAsDataURL(file);
  }, [screenToFlowPosition, setNodes]);

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
    const reader = new FileReader();
    reader.onload = () => {
      const id = String(Date.now());
      const node = {
        id,
        type: 'image',
        position: pos,
        data: { src: reader.result, title: '', description: '', tags: [] },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
      setNodes((ns) => ns.concat(node));
    };
    reader.readAsDataURL(file);
  }, [screenToFlowPosition, setNodes]);

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
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [mode, setMode] = React.useState('select');
  const [connectFrom, setConnectFrom] = React.useState(null);
  const [menu, setMenu] = React.useState(null); // { left, top, type: 'node'|'edge', id, source?, target? }
  const [edgeEditor, setEdgeEditor] = React.useState(null); // { id, left, top, label, color, width, type, animated, dashed }
  const [contextMenusEnabled, setContextMenusEnabled] = React.useState(true);

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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
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
        />
        <DropReceiver setNodes={setNodes} />
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
