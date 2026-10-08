// Stands for a test that needs infrastructure the unit run does not have. It always fails, so
// the run is only green when the unit script's ignore pattern keeps it out.
it("needs a database", () => {
  throw new Error("no database in a unit run");
});
