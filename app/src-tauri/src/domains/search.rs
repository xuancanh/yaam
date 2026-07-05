//! Embedded full-text search over chat transcripts, powered by tantivy — the
//! standard embedded search-engine library in Rust (Lucene-style inverted
//! index). Chat volumes are small, so the index lives in RAM. The frontend does
//! a full `reindex` on load, then keeps it current with incremental `upsert`
//! (replace-by-msg_id) and `remove` calls so a single new message no longer
//! rebuilds the whole index.
use std::sync::Mutex;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, TantivyDocument, Value, STORED, STRING, TEXT};
use tantivy::{doc, Index, IndexReader, IndexWriter, Term};

struct Engine {
    index: Index,
    reader: IndexReader,
    /// kept alive so upsert/remove can mutate the live index incrementally
    writer: IndexWriter,
    chat_id: Field,
    msg_id: Field,
    role: Field,
    text: Field,
}

/// Bound one message's contribution to the in-RAM index (unicode-safe cut).
fn bound_body(text: String) -> String {
    if text.len() <= 20_000 {
        return text;
    }
    let cut = text
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|&i| i <= 20_000)
        .last()
        .unwrap_or(0);
    text[..cut].to_string()
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
    // msg_id is STRING (indexed as one raw term) so upsert/remove can delete by it
    let msg_id = schema_builder.add_text_field("msg_id", STRING | STORED);
    let role = schema_builder.add_text_field("role", STORED);
    let text = schema_builder.add_text_field("text", TEXT | STORED);
    let schema = schema_builder.build();

    let index = Index::create_in_ram(schema);
    let mut writer: IndexWriter = index.writer(15_000_000).map_err(|e| e.to_string())?;
    let count = docs.len();
    for d in docs {
        writer
            .add_document(doc!(
                chat_id => d.chat_id,
                msg_id => d.msg_id,
                role => d.role,
                text => bound_body(d.text),
            ))
            .map_err(|e| e.to_string())?;
    }
    writer.commit().map_err(|e| e.to_string())?;
    let reader = index.reader().map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(Engine {
        index,
        reader,
        writer,
        chat_id,
        msg_id,
        role,
        text,
    });
    Ok(count)
}

/// Incrementally add/replace messages by msg_id. Falls back to a full reindex
/// when no index exists yet (first call). Returns the number of docs written.
pub fn upsert(state: &ChatSearchState, docs: Vec<ChatDoc>) -> Result<usize, String> {
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(engine) = guard.as_mut() {
            let count = docs.len();
            for d in docs {
                // replace any existing doc with this msg_id, then add the new one
                engine
                    .writer
                    .delete_term(Term::from_field_text(engine.msg_id, &d.msg_id));
                engine
                    .writer
                    .add_document(doc!(
                        engine.chat_id => d.chat_id,
                        engine.msg_id => d.msg_id,
                        engine.role => d.role,
                        engine.text => bound_body(d.text),
                    ))
                    .map_err(|e| e.to_string())?;
            }
            engine.writer.commit().map_err(|e| e.to_string())?;
            engine.reader.reload().map_err(|e| e.to_string())?;
            return Ok(count);
        }
    }
    reindex(state, docs)
}

/// Remove messages from the index by msg_id (e.g. a deleted chat). No-op when
/// there is no index yet. Returns the number of ids requested for removal.
pub fn remove(state: &ChatSearchState, msg_ids: Vec<String>) -> Result<usize, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(engine) = guard.as_mut() else {
        return Ok(0);
    };
    let count = msg_ids.len();
    for id in &msg_ids {
        engine
            .writer
            .delete_term(Term::from_field_text(engine.msg_id, id));
    }
    engine.writer.commit().map_err(|e| e.to_string())?;
    engine.reader.reload().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Query the index; returns the best-matching messages with their chat ids.
pub fn search(
    state: &ChatSearchState,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ChatHit>, String> {
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

#[tauri::command]
pub fn chat_search_reindex(
    state: tauri::State<'_, ChatSearchState>,
    docs: Vec<ChatDoc>,
) -> Result<usize, String> {
    reindex(&state, docs)
}

#[tauri::command]
pub fn chat_search_upsert(
    state: tauri::State<'_, ChatSearchState>,
    docs: Vec<ChatDoc>,
) -> Result<usize, String> {
    upsert(&state, docs)
}

#[tauri::command]
pub fn chat_search_remove(
    state: tauri::State<'_, ChatSearchState>,
    msg_ids: Vec<String>,
) -> Result<usize, String> {
    remove(&state, msg_ids)
}

#[tauri::command]
pub fn chat_search(
    state: tauri::State<'_, ChatSearchState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ChatHit>, String> {
    search(&state, query, limit)
}

#[cfg(test)]
mod tests {
    use super::{reindex, remove, search, upsert, ChatDoc, ChatSearchState};

    fn doc(chat_id: &str, msg_id: &str, role: &str, text: &str) -> ChatDoc {
        ChatDoc {
            chat_id: chat_id.to_string(),
            msg_id: msg_id.to_string(),
            role: role.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn search_before_the_first_index_is_empty() {
        let state = ChatSearchState::default();
        assert!(search(&state, "anything".to_string(), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reindex_returns_searchable_messages_with_metadata_and_limit() {
        let state = ChatSearchState::default();
        let count = reindex(
            &state,
            vec![
                doc("chat-a", "msg-1", "user", "Rust persistence recovery"),
                doc("chat-b", "msg-2", "assistant", "Rust session manager"),
                doc("chat-c", "msg-3", "assistant", "unrelated frontend text"),
            ],
        )
        .unwrap();

        assert_eq!(count, 3);
        let hits = search(&state, "rust".to_string(), Some(1)).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].chat_id == "chat-a" || hits[0].chat_id == "chat-b");
        assert!(hits[0].msg_id.starts_with("msg-"));
        assert!(hits[0].role == "user" || hits[0].role == "assistant");
        assert!(hits[0].score > 0.0);
    }

    #[test]
    fn a_new_index_replaces_old_documents_and_truncates_unicode_safely() {
        let state = ChatSearchState::default();
        reindex(
            &state,
            vec![doc("old", "old-msg", "user", "obsolete marker")],
        )
        .unwrap();

        let long = format!("needle {}", "é".repeat(11_000));
        reindex(&state, vec![doc("new", "new-msg", "assistant", &long)]).unwrap();

        assert!(search(&state, "obsolete".to_string(), None)
            .unwrap()
            .is_empty());
        let hits = search(&state, "needle".to_string(), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chat_id, "new");
        assert!(hits[0].text.len() <= 20_000);
    }

    #[test]
    fn upsert_falls_back_to_a_full_index_when_none_exists_yet() {
        let state = ChatSearchState::default();
        upsert(&state, vec![doc("c", "m1", "user", "alpha keyword")]).unwrap();
        let hits = search(&state, "alpha".to_string(), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].msg_id, "m1");
    }

    #[test]
    fn upsert_adds_new_and_replaces_by_msg_id() {
        let state = ChatSearchState::default();
        reindex(&state, vec![doc("c", "m1", "user", "alpha original")]).unwrap();

        // add a brand-new message
        upsert(&state, vec![doc("c", "m2", "assistant", "beta added")]).unwrap();
        assert_eq!(search(&state, "beta".to_string(), None).unwrap().len(), 1);

        // replace m1's text — the old term must not linger, and there must be
        // exactly one doc for m1 afterwards (delete_term dedups)
        upsert(&state, vec![doc("c", "m1", "user", "alpha rewritten")]).unwrap();
        assert!(search(&state, "original".to_string(), None).unwrap().is_empty());
        let rewritten = search(&state, "rewritten".to_string(), None).unwrap();
        assert_eq!(rewritten.len(), 1);
        assert_eq!(rewritten[0].msg_id, "m1");
    }

    #[test]
    fn remove_deletes_by_msg_id() {
        let state = ChatSearchState::default();
        reindex(
            &state,
            vec![
                doc("c", "m1", "user", "gamma one"),
                doc("c", "m2", "user", "gamma two"),
            ],
        )
        .unwrap();
        assert_eq!(search(&state, "gamma".to_string(), None).unwrap().len(), 2);

        assert_eq!(remove(&state, vec!["m1".to_string()]).unwrap(), 1);
        let left = search(&state, "gamma".to_string(), None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].msg_id, "m2");
    }

    #[test]
    fn remove_before_any_index_is_a_no_op() {
        let state = ChatSearchState::default();
        assert_eq!(remove(&state, vec!["x".to_string()]).unwrap(), 0);
    }
}
