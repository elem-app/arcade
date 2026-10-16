import { describe, expect, it } from "vitest";

import {
  AskAudienceInputSchema,
  DiscussInputSchema,
  outboundQuestionForm,
  parseAskAudienceInput,
  parseDiscussInput,
} from "../src/backends/managed-worker-tools.js";

describe("managed worker question contract", () => {
  it("declares presentation-specific managed question tools", () => {
    expect(
      DiscussInputSchema.shape.question.safeParse("Discuss this").success,
    ).toBe(true);
    expect(AskAudienceInputSchema.shape.questions.safeParse([]).success).toBe(
      false,
    );
    expect(
      DiscussInputSchema.parse({
        question: "What should change?",
      }),
    ).toEqual({ question: "What should change?" });
    expect(
      AskAudienceInputSchema.parse({
        questions: [
          {
            question: "Approve?",
            header: "Approval",
            options: [
              { label: "Yes", description: "Approve." },
              { label: "No", description: "Reject." },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toMatchObject({ questions: expect.any(Array) });

    expect(parseDiscussInput({ question: "  Discuss this  " })).toEqual({
      question: "Discuss this",
    });
    expect(
      parseAskAudienceInput({
        audience: "reviewer",
        questions: [
          {
            question: "Approve?",
            header: "Approval",
            options: [
              { label: "Yes", description: "Approve." },
              { label: "No", description: "Reject." },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toMatchObject({ audience: "reviewer" });

    expect(
      outboundQuestionForm(
        parseAskAudienceInput({
          questions: [
            {
              question: "Approve?",
              header: "Approval",
              options: [
                { label: "Yes", description: "Approve." },
                { label: "No", description: "Reject." },
              ],
              multiSelect: false,
            },
          ],
        }).questions,
      ),
    ).toMatchObject({
      kind: "question-form",
      questions: [{ takesOtherAnswer: true }],
    });
  });
});
