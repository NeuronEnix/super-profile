CREATE VIRTUAL TABLE kb_articles_fts USING fts5(title, body_text, content='kb_articles', content_rowid='rowid');

CREATE TRIGGER kb_articles_ai AFTER INSERT ON kb_articles BEGIN
  INSERT INTO kb_articles_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;

CREATE TRIGGER kb_articles_ad AFTER DELETE ON kb_articles BEGIN
  INSERT INTO kb_articles_fts(kb_articles_fts, rowid, title, body_text) VALUES('delete', old.rowid, old.title, old.body_text);
END;

CREATE TRIGGER kb_articles_au AFTER UPDATE ON kb_articles BEGIN
  INSERT INTO kb_articles_fts(kb_articles_fts, rowid, title, body_text) VALUES('delete', old.rowid, old.title, old.body_text);
  INSERT INTO kb_articles_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
