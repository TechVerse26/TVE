import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, Chips, Empty, Head, Ico, Page, Rich, SearchBox } from "../../ui/kit";
import { DOCS, faqAnswerHtml, faqCategories, faqSearch, whatsNew, type Block, type Doc } from "../../core/content";
import { helpCircleOutline, sparklesOutline } from "ionicons/icons";

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p": return <Rich html={`<p>${b.html}</p>`} />;
    case "h": return <h3 style={{ marginTop: 6 }}>{b.text}</h3>;
    case "ul": return <ul className="rich" style={{ margin: 0 }}>{b.items.map((h, i) => <li key={i} dangerouslySetInnerHTML={{ __html: h }} />)}</ul>;
    case "ol": return <ol className="rich" style={{ margin: 0 }}>{b.items.map((h, i) => <li key={i} dangerouslySetInnerHTML={{ __html: h }} />)}</ol>;
    case "note": return <div className={`banner ${b.tone === "warn" ? "warn" : "info"}`} style={{ display: "block" }} dangerouslySetInnerHTML={{ __html: b.html }} />;
    case "table": return <div className="tblwrap"><table className="tbl"><caption className="tiny muted" style={{ textAlign: "left", padding: 8 }}>{b.caption}</caption><thead><tr>{b.cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead><tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} dangerouslySetInnerHTML={{ __html: c }} />)}</tr>)}</tbody></table></div>;
    case "dl": return <div className="stack-s">{b.rows.map((r, i) => <div key={i}><p className="strong" dangerouslySetInnerHTML={{ __html: r.term }} /><Rich html={r.html} className="muted" /></div>)}</div>;
    case "cards": return <div className="grid-2">{b.items.map((c, i) => <div key={i} className="stat"><b style={{ fontSize: 15 }}>{c.title}</b><Rich html={c.html} className="small muted" /></div>)}</div>;
  }
}

function DocView({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState<string>("");
  return (
    <>
      {doc.lead && <p className="muted">{doc.lead}</p>}
      <div className="stack">{doc.sections.map((s) => s.title ? (
        <Card className="flush" key={s.id}>
          <details open={open === s.id} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setOpen(s.id); }} style={{ padding: "0 16px" }}>
            <summary style={{ padding: "14px 0", fontWeight: 650, cursor: "pointer", listStyle: "none" }}>{s.title}{s.sub && <span className="small muted" style={{ display: "block", fontWeight: 450 }}>{s.sub}</span>}</summary>
            <div className="stack" style={{ paddingBottom: 16 }}>{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>
          </details>
        </Card>
      ) : <Card key={s.id}><div className="stack">{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</div></Card>)}</div>
    </>
  );
}

function Faq() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [open, setOpen] = useState("");
  const cats = faqCategories();
  const items = useMemo(() => faqSearch(q, cat), [q, cat]);
  return (
    <>
      <SearchBox value={q} onChange={setQ} placeholder="Search questions" />
      <Chips options={[{ id: "", label: "All" }, ...cats.map((c) => ({ id: c.id, label: c.title }))]} value={cat} onChange={setCat} />
      {items.length === 0 ? <Empty icon={helpCircleOutline} title="No matching questions" text="Try different words, or open the Help Center." /> : (
        <Card className="flush"><div className="list">{items.map((it) => (
          <div key={it.id}>
            <button className="listrow" onClick={() => setOpen(open === it.id ? "" : it.id)} aria-expanded={open === it.id}><span className="grow strong">{it.q}</span></button>
            {open === it.id && <div style={{ padding: "0 16px 14px" }}><Rich html={faqAnswerHtml(it.a)} /></div>}
          </div>))}</div></Card>
      )}
    </>
  );
}

export default function Info() {
  const { kind } = useParams<{ kind: string }>();
  if (kind === "faq") return <Page title="FAQ" back><Faq /></Page>;
  if (kind === "whats-new") {
    const w = whatsNew();
    return (
      <Page title="What's new" back>
        <Card tone="soft"><p className="strong">{w.title}</p><p className="small">Version {w.version} · {w.date}</p>{w.lead && <p style={{ marginTop: 6 }}>{w.lead}</p>}</Card>
        <Head title="Highlights" />
        <div className="stack">{w.items.map((i, k) => <Card key={k}><div className="row" style={{ alignItems: "flex-start" }}><div className="lead listrow" style={{ padding: 0, width: 38, height: 38, flex: "none", borderRadius: 12, background: "var(--c-accent-soft)", display: "grid", placeItems: "center" }}><Ico n={sparklesOutline} /></div><div><h3>{i.title}</h3><p className="muted small">{i.text}</p></div></div></Card>)}</div>
      </Page>
    );
  }
  const d = DOCS[kind];
  if (!d) return <Page title="Information" back><Empty icon={helpCircleOutline} title="Page not found" /></Page>;
  return <Page title={d.title} back><DocView doc={d.build()} /></Page>;
}
