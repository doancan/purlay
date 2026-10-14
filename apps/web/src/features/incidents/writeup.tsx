/**
 * What is written down for an incident, in its panel (#487, D-137 §3, §5): the runbook it follows, a
 * link opened in a new tab, and its postmortem, drawn as a message is. A member of the channel sets,
 * changes and removes the runbook, and writes the postmortem; a visitor reads both.
 *
 * The postmortem is saved from the version the person began at. If somebody else saved since, the
 * person's words stay in the editor and what the other saved is shown above it, to read before saving
 * again. A draft outlives the panel closing — a thread opened takes the side — for this visit to the
 * page, never longer.
 */
import type { Incident } from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { renderContent } from '../content/render-content';
import type { IncidentActions } from './use-incident';

/** Postmortem drafts by incident, with the version each began at: kept while the page is. */
const drafts = new Map<string, { readonly text: string; readonly from: number }>();

const fieldClasses =
  'w-full rounded-md border-hairline border-border-subtle bg-surface-050 px-2 py-1 text-body text-ink';

const Runbook = ({
  incident,
  actions,
  member,
}: {
  readonly incident: Incident;
  readonly actions: IncidentActions;
  readonly member: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const field = useId();
  const box = useRef<HTMLDivElement>(null);
  const url = incident.runbookUrl;
  /** The form goes: the person's place is the section's link or first button, never nothing. */
  const returning = useRef(false);
  const back = (): void => {
    returning.current = true;
  };
  // Once the form has gone and what replaces it is drawn — not a frame that may come first.
  useEffect(() => {
    if (editing || !returning.current) return;
    returning.current = false;
    box.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [editing]);
  const save = (runbookUrl: string | null): void => {
    setEditing(false);
    back();
    void actions.change(incident, { runbookUrl }).then((done) => {
      // Refused: the form comes back with what was typed, to correct rather than type again.
      if (!done && runbookUrl !== null) setEditing(true);
    });
  };
  return (
    <div ref={box} className="flex flex-col gap-1">
      <h3 className="text-label font-semibold text-ink">{t('incident.runbook')}</h3>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save(value.trim());
          }}
        >
          <input
            id={field}
            type="url"
            required
            pattern="https://.+"
            aria-label={t('incident.runbookLink')}
            value={value}
            placeholder="https://"
            className={fieldClasses}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                back();
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('incident.save')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {url === null ? (
            <span className="text-label text-ink-muted">{t('incident.noRunbook')}</span>
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-label text-accent-text underline"
            >
              {url}
            </a>
          )}
          {member && (
            <Button
              variant="ghost"
              onClick={() => {
                setValue(url ?? 'https://');
                setEditing(true);
              }}
            >
              {t(url === null ? 'incident.addRunbook' : 'incident.changeRunbook')}
            </Button>
          )}
          {member && url !== null && (
            <Button
              variant="dangerQuiet"
              onClick={() => {
                save(null);
              }}
            >
              {t('incident.removeRunbook')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

const Postmortem = ({
  incident,
  actions,
  member,
}: {
  readonly incident: Incident;
  readonly actions: IncidentActions;
  readonly member: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [draft, setDraft] = useState(drafts.get(incident.id));
  const [busy, setBusy] = useState(false);
  /**
   * What somebody else saved while this was being written, as the person was shown it: the only
   * version a save may go over. Another save after it is refused again, never written over unseen.
   */
  const [seen, setSeen] = useState<{ readonly text: string; readonly version: number } | null>(
    null,
  );
  const [awaiting, setAwaiting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const write = (next: { readonly text: string; readonly from: number } | undefined): void => {
    if (next === undefined) drafts.delete(incident.id);
    else drafts.set(incident.id, next);
    setDraft(next);
  };
  /** The editor goes: the person's place is the Write or Edit button that brings it back. */
  const returning = useRef(false);
  const back = (): void => {
    returning.current = true;
  };
  useEffect(() => {
    if (draft !== undefined || !returning.current) return;
    returning.current = false;
    box.current?.querySelector<HTMLElement>('[data-postmortem-edit]')?.focus();
  }, [draft]);
  // Refused as changed: the read again lands, and what it says is what the person is shown.
  const landed = incident.postmortemVersion;
  useEffect(() => {
    if (!awaiting || draft === undefined || landed === (seen?.version ?? draft.from)) return;
    setSeen({ text: incident.postmortem, version: landed });
    setAwaiting(false);
  }, [awaiting, draft, landed, seen, incident.postmortem]);

  const shown = draft === undefined ? incident.postmortem : seen?.text;
  return (
    <div ref={box} className="flex flex-col gap-1">
      <h3 className="text-label font-semibold text-ink">{t('incident.postmortem')}</h3>
      {shown !== undefined &&
        (shown === '' ? (
          <span className="text-label text-ink-muted">{t('incident.noPostmortem')}</span>
        ) : (
          <div
            aria-label={t(draft === undefined ? 'incident.postmortem' : 'incident.savedMeanwhile')}
            role="region"
          >
            {renderContent(shown)}
          </div>
        ))}
      {draft === undefined
        ? member && (
            <Button
              variant="ghost"
              className="self-start"
              data-postmortem-edit=""
              onClick={() => {
                write({ text: incident.postmortem, from: incident.postmortemVersion });
                requestAnimationFrame(() => editor.current?.focus());
              }}
            >
              {t(
                incident.postmortem === '' ? 'incident.writePostmortem' : 'incident.editPostmortem',
              )}
            </Button>
          )
        : member && (
            <div className="flex flex-col gap-2">
              <textarea
                ref={editor}
                aria-label={t('incident.postmortem')}
                rows={8}
                value={draft.text}
                // Fixed while it is on its way: words typed meanwhile would be lost with the draft.
                readOnly={busy}
                className={fieldClasses}
                onChange={(event) => {
                  write({ text: event.target.value, from: draft.from });
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    write(undefined);
                    setSeen(null);
                    setAwaiting(false);
                    back();
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() => {
                    setBusy(true);
                    const sent = draft.text;
                    // Over what the person was shown, if anything was; otherwise from where they began.
                    const from = seen?.version ?? draft.from;
                    void actions.savePostmortem(incident, sent, from).then((result) => {
                      setBusy(false);
                      // Cancelled while it was on its way: nothing here to update.
                      if (drafts.get(incident.id) === undefined) return;
                      if (result === 'saved') {
                        write(undefined);
                        setSeen(null);
                        back();
                        return;
                      }
                      if (result === 'changed') setAwaiting(true);
                      editor.current?.focus();
                    });
                  }}
                >
                  {t('incident.save')}
                </Button>
              </div>
            </div>
          )}
    </div>
  );
};

export const WriteUp = (props: {
  readonly incident: Incident;
  readonly actions: IncidentActions;
  readonly member: boolean;
}): React.JSX.Element => (
  <section className="flex flex-col gap-3 px-4 pb-3">
    <Runbook {...props} />
    <Postmortem {...props} />
  </section>
);
