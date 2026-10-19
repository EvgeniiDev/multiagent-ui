#!/usr/bin/env python3
"""Isolate host ACP V1 history from an OpenCode V2 database, without editing V2."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile

V1_COLUMNS = {'id', 'type', 'name', 'branch', 'directory', 'extra', 'project_id', 'time_used'}
V2_COLUMNS = {'id', 'provider', 'binding', 'created_at', 'last_used_at'}


def columns(db):
    return {row[1] for row in db.execute('PRAGMA table_info(workspace)')}


def prepare(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target:
        raise ValueError('source and ACP database must be different files')
    if target.exists():
        with closing(sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)) as db:
            if not V1_COLUMNS.issubset(columns(db)):
                raise ValueError('existing ACP database is not V1 compatible; refusing to overwrite it')
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.acp-v1-', suffix='.db', dir=target.parent)
    os.close(fd)
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(tmp)) as dst:
            src.backup(dst)
            # A WAL-mode source transfers its journal mode to the backup.
            # Publish a self-contained main file, never a temp-name WAL.
            dst.execute('PRAGMA journal_mode=DELETE')
            schema = columns(dst)
            if schema == V2_COLUMNS:
                if dst.execute('SELECT count(*) FROM workspace').fetchone()[0]:
                    raise ValueError('V2 workspaces are nonempty; refusing an automatic conversion')
                # Only the isolated copy changes. Keep every legacy and V2
                # session/message table and the original V2 database intact.
                dst.execute('DROP TABLE workspace')
                dst.execute('''CREATE TABLE workspace (
                    id text PRIMARY KEY, type text NOT NULL, name text, branch text,
                    directory text, extra text, project_id text NOT NULL, time_used integer,
                    FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE)''')
            elif not V1_COLUMNS.issubset(schema):
                raise ValueError('unrecognized workspace schema; refusing conversion')
            dst.commit()
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('ACP database integrity check failed')
        # Never replace another process's database or silently re-import over
        # conversations created since the first recovery.
        os.link(tmp, target)
        return True
    finally:
        os.unlink(tmp)


if __name__ == '__main__':
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'opencode'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=data / 'opencode.db')
    parser.add_argument('--target', type=Path, default=data / 'opencode-acp-legacy.db')
    args = parser.parse_args()
    print('Created isolated ACP V1 database' if prepare(args.source, args.target) else 'Existing ACP V1 database preserved')
