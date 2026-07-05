//! Embedded full-text search over chat transcripts, powered by tantivy — the
//! standard embedded search-engine library in Rust (Lucene-style inverted
//! index). Chat volumes are small, so the index lives in RAM and is rebuilt
//! whenever the frontend pushes a fresh snapshot of all messages.
use std::sync::Mutex;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, TantivyDocument, Value, STORED, TEXT};
use tantivy::{doc, Index, IndexReader};

struct Engine {
    index: Index,
    reader: IndexReader,
    chat_id: Field,
    msg_id: Field,
    role: Field,
    text: Field,
}

#[derive(Default)]
pub struct ChatSearchState(Mutex<Option<Engine>>);

#[derive(serde::Deserialize)]
pub struct ChatDoc {
    pub chat_id: String,
    pub msg_id: String,
    pub role: String,
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct ChatHit {
    pub chat_id: String,
    pub msg_id: String,
    pub role: String,
    pub text: String,
    pub score: f32,
}

/// Rebuild the in-RAM index from the full set of chat messages.
pub fn reindex(state: &ChatSearchState, docs: Vec<ChatDoc>) -> Result<usize, String> {
    let mut schema_builder = Schema::builder();
    let chat_id = schema_builder.add_text_field("chat_id", STORED);
    let msg_id = schema_builder.add_text_field("msg_id", STORED);
    let role = schema_builder.add_text_field("role", STORED);
    let text = schema_builder.add_text_field("text", TEXT | STORED);
    let schema = schema_builder.build();

    let index = Index::create_in_ram(schema);
    let mut writer = index.writer(15_000_000).map_err(|e| e.to_string())?;
    let count = docs.len();
    for d in docs {
        // bound a single message's contribution to the in-RAM index
        let body = if d.text.len() > 20_000 {
            let cut = d
                .text
                .char_indices()
                .map(|(i, _)| i)
                .take_while(|&i| i <= 20_000)
                .last()
                .unwrap_or(0);
            d.text[..cut].to_string()
        } else {
            d.text
        };
        writer
            .add_document(doc!(
                chat_id => d.chat_id,
                msg_id => d.msg_id,
                role => d.role,
                text => body,
            ))
            .map_err(|e| e.to_string())?;
    }
    writer.commit().map_err(|e| e.to_string())?;
    let reader = index.reader().map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(Engine {
        index,
        reader,
        chat_id,
        msg_id,
        role,
        text,
    });
    Ok(count)
}

/// Query the index; returns the best-matching messages with their chat ids.
pub fn search(state: &ChatSearchState, query: String, limit: Option<usize>) -> Result<Vec<ChatHit>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(engine) = guard.as_ref() else {
        return Ok(vec![]);
    };
    let searcher = engine.reader.searcher();
    let parser = QueryParser::for_index(&engine.index, vec![engine.text]);
    let parsed = parser.parse_query_lenient(&query).0;
    let top = searcher
        .search(&parsed, &TopDocs::with_limit(limit.unwrap_or(30).min(100)))
        .map_err(|e| e.to_string())?;

    let field_str = |d: &TantivyDocument, f: Field| -> String {
        d.get_first(f)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let mut hits = Vec::with_capacity(top.len());
    for (score, addr) in top {
        let d: TantivyDocument = searcher.doc(addr).map_err(|e| e.to_string())?;
        hits.push(ChatHit {
            chat_id: field_str(&d, engine.chat_id),
            msg_id: field_str(&d, engine.msg_id),
            role: field_str(&d, engine.role),
            text: field_str(&d, engine.text),
            score,
        });
    }
    Ok(hits)
}
