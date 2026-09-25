import { expect, test, describe, beforeEach } from "bun:test";

const {
  undoStack,
  pushUndoAction,
  triggerUndo
} = require("../extension/app.js");

describe("Undo Stack — LIFO Stack & Execution Lock", () => {
  beforeEach(() => {
    // Ensure 100% test isolation by clearing the module-level undo stack
    undoStack.length = 0;
  });

  test("pushUndoAction pushes restorable action onto the stack", () => {
    let called = false;
    pushUndoAction({
      description: "Close single tab",
      onUndo: async () => { called = true; }
    });

    expect(undoStack.length).toBe(1);
    expect(undoStack[0].description).toBe("Close single tab");
    expect(typeof undoStack[0].onUndo).toBe("function");
  });

  test("pushUndoAction enforces maximum stack limit of 20 items", () => {
    for (let i = 0; i < 25; i++) {
      pushUndoAction({
        description: `Action ${i}`,
        onUndo: async () => {}
      });
    }

    expect(undoStack.length).toBe(20);
    expect(undoStack[undoStack.length - 1].description).toBe("Action 24");
    expect(undoStack[0].description).toBe("Action 5"); // First 5 shifted out
  });

  test("pushUndoAction ignores actions without an onUndo callback function", () => {
    pushUndoAction({ description: "Invalid action" } as any);
    expect(undoStack.length).toBe(0);
  });

  test("triggerUndo executes the topmost action and returns true", async () => {
    let restoredId = 0;
    pushUndoAction({
      description: "First",
      onUndo: async () => { restoredId = 1; }
    });
    pushUndoAction({
      description: "Second",
      onUndo: async () => { restoredId = 2; }
    });

    const success = await triggerUndo();
    expect(success).toBe(true);
    expect(restoredId).toBe(2);
    expect(undoStack.length).toBe(1);
  });

  test("triggerUndo returns false when stack is empty", async () => {
    const success = await triggerUndo();
    expect(success).toBe(false);
  });

  test("triggerUndo prevents concurrent re-entrant execution", async () => {
    let executionCount = 0;
    let resolveInner: () => void;
    const innerPromise = new Promise<void>(res => { resolveInner = res; });

    pushUndoAction({
      description: "Long running undo",
      onUndo: async () => {
        executionCount++;
        await innerPromise;
      }
    });

    // Start first undo
    const p1 = triggerUndo();
    // Attempt concurrent re-entrant undo
    const p2 = triggerUndo();

    expect(await p2).toBe(false); // Second invocation rejected by isUndoing lock

    resolveInner!();
    expect(await p1).toBe(true);
    expect(executionCount).toBe(1);
  });
});
