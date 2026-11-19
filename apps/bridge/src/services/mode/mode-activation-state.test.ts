import { ModeActivationState } from "./mode-activation-state.js";

describe("ModeActivationState", () => {
  it("starts without any activated mode", () => {
    const state = new ModeActivationState();

    expect(state.getActivatedModes()).toEqual([]);
    expect(state.isStudioRestoreActive()).toBe(false);
  });

  it("treats studio and conference as Studio-restoring modes, meeting not", () => {
    const meetingOnly = new ModeActivationState();
    meetingOnly.recordActivation("meeting");
    expect(meetingOnly.isStudioRestoreActive()).toBe(false);

    const studio = new ModeActivationState();
    studio.recordActivation("studio");
    expect(studio.isStudioRestoreActive()).toBe(true);

    const conference = new ModeActivationState();
    conference.recordActivation("conference");
    expect(conference.isStudioRestoreActive()).toBe(true);
  });

  it("reset clears the recorded modes", () => {
    const state = new ModeActivationState();
    state.recordActivation("studio");
    state.reset();

    expect(state.getActivatedModes()).toEqual([]);
    expect(state.isStudioRestoreActive()).toBe(false);
  });
});
