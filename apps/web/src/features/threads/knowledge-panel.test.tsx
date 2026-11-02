import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { Message, SetKnowledgeRequest } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { mountChannel, page, settle } from '../../testing/channel-harness';
import { aMessage, BOB, ME, WHEN } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { expectFocusOn } from '../../testing/focus';
import { expectNoAxeViolations } from '../../testing/axe';
import { knowledgeInput } from './knowledge-input';
import { KnowledgePanel } from './knowledge-panel';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { renderApp } from '../../testing/render';
import { aSignedInApi } from '../../testing/fixtures';

installDom();
const summary = { replyCount: 1, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null };

describe('keeping a question’s answer and decision', () => {
  test('a reader can follow the accepted answer to its source without editing the decision', async () => {
    const answer = aMessage(2);
    const root = aMessage(1, {
      thread: {
        ...summary,
        knowledge: {
          version: 1,
          isQuestion: true,
          assigneeId: null,
          acceptedAnswer: { id: answer.id, content: 'The full reason' },
          decisionNote: 'Keep it',
          decisionUrl: null,
        },
      },
    });
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <KnowledgePanel root={root} replies={[]} member={false} />
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: aSignedInApi() },
    );
    await settle();
    expect(view.queryByRole('button', { name: 'Edit decision' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'Read the full answer' }));
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/c/${root.channelId}?message=${answer.id}`,
    );
    view.unmount();
  });

  test('saves the chosen answer, owner and reason, and keeps the source readable', async () => {
    let root = aMessage(1, { content: 'Why wait?', thread: summary });
    const answer = aMessage(2, { content: 'Quota resets.', parentId: root.id, thread: null });
    const calls: SetKnowledgeRequest[] = [];
    let release = (): void => undefined;
    const view = await mountChannel({
      messages: () => Promise.resolve(page([root])),
      api: {
        thread: () => Promise.resolve(page([answer])),
        channelMembers: () =>
          Promise.resolve([
            { user: ME, joinedAt: WHEN },
            { user: BOB, joinedAt: WHEN },
          ]),
        setKnowledge: (_id, input) => {
          calls.push(input);
          root = {
            ...root,
            thread: {
              ...summary,
              knowledge: {
                ...input,
                version: input.version + 1,
                acceptedAnswer:
                  input.acceptedAnswerId === null
                    ? null
                    : { id: answer.id, content: answer.content },
              },
            },
          };
          return calls.length === 1
            ? new Promise<Message>((resolve) => {
                release = (): void => {
                  resolve(root);
                };
              })
            : Promise.resolve(root);
        },
      },
    });
    await person().click(view.getByRole('button', { name: /Show thread/ }));
    await settle();
    const panel = within(view.getByRole('region', { name: 'Question and decision' }));
    await person().click(panel.getByRole('button', { name: 'Edit decision' }));
    await settle();
    await person().click(panel.getByLabelText('Track as a question'));
    await person().selectOptions(panel.getByLabelText('Responsible person'), BOB.id);
    await person().selectOptions(panel.getByLabelText('Selected answer'), answer.id);
    await person().type(panel.getByLabelText('Decision note'), 'Wait four seconds.');
    await person().type(
      panel.getByLabelText('Related link'),
      'https://github.com/acme/api/issues/1',
    );
    await person().click(panel.getByRole('button', { name: 'Save decision' }));
    expect(panel.getByLabelText('Decision note').hasAttribute('disabled')).toBe(true);
    expect(panel.getByLabelText('Selected answer').hasAttribute('disabled')).toBe(true);
    release();
    await settle();
    expect(calls[0]).toMatchObject({
      version: 0,
      isQuestion: true,
      assigneeId: BOB.id,
      acceptedAnswerId: answer.id,
      decisionNote: 'Wait four seconds.',
    });
    expect(panel.getByText('Quota resets.')).toBeDefined();
    expect(panel.getByRole('link', { name: 'Related link' }).getAttribute('href')).toBe(
      'https://github.com/acme/api/issues/1',
    );
    expectFocusOn(panel.getByRole('button', { name: 'Edit decision' }));
    await expectNoAxeViolations(view.getByRole('region', { name: 'Question and decision' }));
    await person().click(panel.getByRole('button', { name: 'Edit decision' }));
    await person().click(panel.getByLabelText('Track as a question'));
    await person().selectOptions(panel.getByLabelText('Selected answer'), '');
    await person().click(panel.getByLabelText('Related link'));
    await person().keyboard('{Control>}a{/Control}{Backspace}');
    await person().click(panel.getByRole('button', { name: 'Save decision' }));
    await settle();
    expect(calls[1]).toMatchObject({
      version: 1,
      isQuestion: false,
      assigneeId: null,
      acceptedAnswerId: null,
      decisionUrl: null,
    });
    await person().click(panel.getByRole('button', { name: 'Edit decision' }));
    await person().click(panel.getByRole('button', { name: 'Cancel' }));
    expect(panel.queryByLabelText('Decision note')).toBeNull();
    view.unmountAll();
  });

  test('a conflict keeps the draft until the latest version is explicitly reviewed; member reads retry', async () => {
    let root: Message = aMessage(1, { thread: summary });
    let memberReads = 0;
    let membersOffline = true;
    let writes = 0;
    const calls: SetKnowledgeRequest[] = [];
    const view = await mountChannel({
      messages: () => Promise.resolve(page([root])),
      api: {
        thread: () => Promise.resolve(page([])),
        channelMembers: () => {
          memberReads++;
          return membersOffline
            ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'Offline'))
            : Promise.resolve([]);
        },
        setKnowledge: (_id, input) => {
          calls.push(input);
          root = {
            ...root,
            thread: {
              ...summary,
              knowledge: {
                ...knowledgeInput(root),
                version: 2,
                isQuestion: true,
                decisionNote: 'Someone else’s reason',
                acceptedAnswer: null,
              },
            },
          };
          return ++writes === 1
            ? Promise.reject(new ApiError(409, 'KNOWLEDGE_CONFLICT', 'Changed'))
            : Promise.resolve(root);
        },
      },
    });
    await person().click(view.getByRole('button', { name: /Show thread/ }));
    await settle();
    const panel = within(view.getByRole('region', { name: 'Question and decision' }));
    await person().click(panel.getByRole('button', { name: 'Edit decision' }));
    await person().click(panel.getByLabelText('Track as a question'));
    await settle();
    membersOffline = false;
    await person().click(panel.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(memberReads).toBeGreaterThanOrEqual(2);
    await person().type(panel.getByLabelText('Decision note'), 'My reason');
    await person().click(panel.getByRole('button', { name: 'Save decision' }));
    await settle();
    expect(panel.getByRole('alert').textContent).toContain('changed');
    expect(panel.getByLabelText<HTMLTextAreaElement>('Decision note').value).toBe('My reason');
    expect(panel.getByText('Someone else’s reason')).toBeDefined();
    await person().click(panel.getByRole('button', { name: 'I reviewed the latest version' }));
    await person().click(panel.getByRole('button', { name: 'Save decision' }));
    await settle();
    expect(calls[1]).toMatchObject({ version: 2, decisionNote: 'My reason' });
    view.unmountAll();
  });
});
