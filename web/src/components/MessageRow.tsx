import type { KeyboardEvent } from "react";
import {
  causeToKind,
  displayContent,
  formatTime,
  glyphForKind,
  isQuestionFormContent,
  kindLabel,
  labelForCause,
  resolutionText,
  snippetForContent,
  statusBadge,
} from "../lib/format";
import type {
  OutboundItem,
  PermissionDecision,
  QuestionFormContent,
  QuestionFormQuestion,
} from "../types";
import { MarkdownContent } from "./MarkdownContent";

type MessageRowProps = {
  item: OutboundItem;
  expanded: boolean;
  answerDrafts: Record<string, string>;
  busy: boolean;
  onToggleExpanded(id: string): void;
  onDraftChange(key: string, value: string): void;
  onAnswer(id: string, content: string): void;
  onPermission(id: string, decision: PermissionDecision): void;
  onAck(id: string): void;
};

const OTHER_VALUE = "__other__";

type StructuredAnswerValue = string | string[];

export function MessageRow({
  item,
  expanded,
  answerDrafts,
  busy,
  onToggleExpanded,
  onDraftChange,
  onAnswer,
  onPermission,
  onAck,
}: MessageRowProps) {
  const kind = causeToKind(item.situation.cause);
  const pending = item.status === "pending";
  const collapsed = pending || expanded ? "false" : "true";
  const answer = answerDrafts[item.id] ?? "";
  const structuredContent: QuestionFormContent | undefined =
    kind === "question" && isQuestionFormContent(item.content)
      ? item.content
      : undefined;
  const structuredAnswer = structuredContent
    ? buildStructuredAnswer(item.id, structuredContent.questions, answerDrafts)
    : undefined;
  const canSend = structuredContent
    ? structuredAnswer !== undefined
    : answer.trim().length > 0;

  function toggleIfAnswered() {
    if (!pending) onToggleExpanded(item.id);
  }

  function onThinKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleIfAnswered();
    }
  }

  return (
    <article
      className="msg"
      data-state={pending ? "pending" : "answered"}
      data-collapsed={collapsed}
      data-kind={kindLabel(kind)}
    >
      <button
        className="msg-row"
        type="button"
        disabled={pending}
        aria-expanded={pending ? true : expanded}
        onClick={toggleIfAnswered}
        onKeyDown={onThinKeyDown}
      >
        <span className="glyph">{glyphForKind(kind)}</span>
        <span className="kind">{kindLabel(kind)}</span>
        <span className="snippet">{snippetForContent(item.content)}</span>
        <span className="when">{formatTime(item.updatedAt)}</span>
      </button>
      <div className="msg-fat">
        <button
          className="fat-head"
          type="button"
          disabled={pending}
          aria-expanded={pending ? true : expanded}
          onClick={toggleIfAnswered}
        >
          <span className="fat-kind">
            {labelForCause(item.situation.cause)}
          </span>
          <span className={`badge ${badgeClass(item.status)} dot`}>
            {statusBadge(item.status)}
          </span>
        </button>
        <div className="fat-body">
          {structuredContent ? (
            <StructuredQuestionContent
              item={item}
              questions={structuredContent.questions}
              answerDrafts={answerDrafts}
              busy={busy}
              onDraftChange={onDraftChange}
            />
          ) : typeof item.content === "string" ? (
            <MarkdownContent content={item.content} />
          ) : (
            <pre>{displayContent(item.content)}</pre>
          )}
        </div>
        {structuredContent ? (
          <details className="raw-json">
            <summary>Raw JSON</summary>
            <pre>{displayContent(item.content)}</pre>
          </details>
        ) : null}
        <div className="fat-meta">
          {item.situation.role} · {item.situation.audience} ·{" "}
          {item.situation.cause} · {formatTime(item.createdAt)}
        </div>
        <div className="resolution">{resolutionText(item)}</div>
        {pending ? (
          <PendingActions
            item={item}
            answer={answer}
            canSend={canSend}
            structuredAnswer={structuredAnswer}
            busy={busy}
            onDraftChange={onDraftChange}
            onAnswer={onAnswer}
            onPermission={onPermission}
            onAck={onAck}
          />
        ) : null}
      </div>
    </article>
  );
}

function PendingActions({
  item,
  answer,
  canSend,
  structuredAnswer,
  busy,
  onDraftChange,
  onAnswer,
  onPermission,
  onAck,
}: {
  item: OutboundItem;
  answer: string;
  canSend: boolean;
  structuredAnswer: string | undefined;
  busy: boolean;
  onDraftChange(key: string, value: string): void;
  onAnswer(id: string, content: string): void;
  onPermission(id: string, decision: PermissionDecision): void;
  onAck(id: string): void;
}) {
  const kind = causeToKind(item.situation.cause);
  if (kind === "question") {
    const isStructured = isQuestionFormContent(item.content);
    return (
      <>
        {!isStructured ? (
          <textarea
            className="answer-box"
            value={answer}
            onChange={(event) => onDraftChange(item.id, event.target.value)}
            placeholder="Type a response..."
            rows={3}
          />
        ) : null}
        <div className="actions">
          <button
            className="btn primary sm"
            type="button"
            disabled={busy || !canSend}
            onClick={() => onAnswer(item.id, structuredAnswer ?? answer.trim())}
          >
            Send answer
          </button>
        </div>
      </>
    );
  }
  if (kind === "permission") {
    return (
      <div className="actions">
        <button
          className="btn primary sm"
          type="button"
          disabled={busy}
          onClick={() => onPermission(item.id, "allow")}
        >
          Allow once
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          onClick={() => onPermission(item.id, "allow_this_run")}
        >
          Allow for this run
        </button>
        <button
          className="btn ghost sm"
          type="button"
          disabled={busy}
          onClick={() => onPermission(item.id, "deny")}
        >
          Deny
        </button>
      </div>
    );
  }
  return (
    <div className="actions">
      <button
        className="btn primary sm"
        type="button"
        disabled={busy}
        onClick={() => onAck(item.id)}
      >
        Acknowledge
      </button>
    </div>
  );
}

function StructuredQuestionContent({
  item,
  questions,
  answerDrafts,
  busy,
  onDraftChange,
}: {
  item: OutboundItem;
  questions: QuestionFormQuestion[];
  answerDrafts: Record<string, string>;
  busy: boolean;
  onDraftChange(key: string, value: string): void;
}) {
  const readOnly = item.status !== "pending";
  const answeredValues = readOnly
    ? structuredAnsweredValues(item, questions)
    : [];
  return (
    <div className="structured-questions">
      {questions.map((question, index) => {
        const choiceKey = structuredChoiceKey(item.id, index);
        const otherKey = structuredOtherKey(item.id, index);
        const selectedValue = readOnly
          ? (answeredValues[index] ?? "")
          : (answerDrafts[choiceKey] ?? "");
        const selectedValues = answerValuesForQuestion(selectedValue);
        const optionLabels = (question.options ?? []).map(
          (option) => option.label,
        );
        const otherAnswers = selectedValues.filter(
          (value) => !optionLabels.includes(value),
        );
        const otherChecked = readOnly
          ? otherAnswers.length > 0
          : selectedValues.includes(OTHER_VALUE);
        const otherValue = readOnly
          ? otherChecked
            ? otherAnswers.join(", ")
            : ""
          : (answerDrafts[otherKey] ?? "");
        return (
          <fieldset
            className="structured-question"
            data-readonly={readOnly}
            key={questionKey(question, index)}
          >
            {question.header ? <legend>{question.header}</legend> : null}
            <p>{question.question}</p>
            {(question.options ?? []).map((option) => (
              <label className="option-row" key={option.label}>
                <span className="option-first-line">
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={choiceKey}
                    value={option.label}
                    checked={selectedValues.includes(option.label)}
                    disabled={busy || readOnly}
                    onChange={() =>
                      updateStructuredChoice(
                        question,
                        choiceKey,
                        selectedValues,
                        option.label,
                        onDraftChange,
                      )
                    }
                  />
                  <strong>{option.label}</strong>
                </span>
                {option.description ? <em>{option.description}</em> : null}
                {option.preview ? <code>{option.preview}</code> : null}
              </label>
            ))}
            {question.takesOtherAnswer ? (
              <label className="option-row other-answer">
                <span className="option-first-line">
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={choiceKey}
                    value={OTHER_VALUE}
                    checked={otherChecked}
                    disabled={busy || readOnly}
                    onChange={() =>
                      updateStructuredChoice(
                        question,
                        choiceKey,
                        selectedValues,
                        OTHER_VALUE,
                        onDraftChange,
                      )
                    }
                  />
                  <strong>Other</strong>
                </span>
                <input
                  value={otherValue}
                  disabled={
                    busy || readOnly || !selectedValues.includes(OTHER_VALUE)
                  }
                  onChange={(event) =>
                    onDraftChange(otherKey, event.target.value)
                  }
                  placeholder="Type a custom answer"
                />
              </label>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

function structuredAnsweredValues(
  item: OutboundItem,
  questions: QuestionFormQuestion[],
): StructuredAnswerValue[] {
  const raw = item.answer?.content?.trim();
  if (!raw) return [];

  const parsed = parseStructuredAnswer(raw);
  if (Array.isArray(parsed)) {
    const strings = stringsFromUnknownArray(parsed);
    if (questions.length === 1 && strings.length === parsed.length) {
      return [strings];
    }
    return parsed.map((value) => (typeof value === "string" ? value : ""));
  }
  if (parsed && typeof parsed === "object") {
    return questions.map((question, index) => {
      const key =
        question.header || question.question || `question-${index + 1}`;
      const value = parsed[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const strings = stringsFromUnknownArray(value);
        if (strings.length === value.length) return strings;
      }
      return "";
    });
  }
  return questions.length === 1 ? [raw] : [];
}

function parseStructuredAnswer(
  raw: string,
): Record<string, unknown> | unknown[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function buildStructuredAnswer(
  itemId: string,
  questions: QuestionFormQuestion[],
  drafts: Record<string, string>,
): string | undefined {
  const answers = questions.map((question, index) => {
    const choiceKey = structuredChoiceKey(itemId, index);
    const selectedValues = answerValuesForQuestion(drafts[choiceKey] ?? "");
    if (selectedValues.length === 0) return undefined;
    const resolvedValues = selectedValues.map((selected) =>
      selected === OTHER_VALUE
        ? (drafts[structuredOtherKey(itemId, index)] ?? "").trim()
        : selected,
    );
    if (resolvedValues.some((value) => value.length === 0)) return undefined;
    const value = question.multiSelect ? resolvedValues : resolvedValues[0];
    if (value === undefined) return undefined;
    return {
      key: question.header || question.question || `question-${index + 1}`,
      value,
    };
  });
  if (answers.some((answer) => answer === undefined)) return undefined;
  const complete = answers as { key: string; value: StructuredAnswerValue }[];
  if (complete.length === 1) {
    const value = complete[0]?.value;
    return Array.isArray(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(
    Object.fromEntries(complete.map((answer) => [answer.key, answer.value])),
  );
}

function updateStructuredChoice(
  question: QuestionFormQuestion,
  choiceKey: string,
  selectedValues: string[],
  value: string,
  onDraftChange: (key: string, value: string) => void,
): void {
  if (!question.multiSelect) {
    onDraftChange(choiceKey, value);
    return;
  }
  const next = selectedValues.includes(value)
    ? selectedValues.filter((item) => item !== value)
    : [...selectedValues, value];
  onDraftChange(choiceKey, JSON.stringify(next));
}

function answerValuesForQuestion(value: StructuredAnswerValue): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const parsed = parseStructuredAnswer(value);
  if (Array.isArray(parsed)) {
    const strings = stringsFromUnknownArray(parsed);
    if (strings.length === parsed.length) return strings;
  }
  return [value];
}

function stringsFromUnknownArray(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function structuredChoiceKey(itemId: string, index: number): string {
  return `${itemId}:structured:${index}:choice`;
}

function structuredOtherKey(itemId: string, index: number): string {
  return `${itemId}:structured:${index}:other`;
}

function questionKey(question: QuestionFormQuestion, index: number): string {
  return `${question.header ?? ""}:${question.question}:${index}`;
}

function badgeClass(status: OutboundItem["status"]): string {
  if (status === "pending") return "waiting";
  if (status === "failed") return "failed";
  return "completed";
}
