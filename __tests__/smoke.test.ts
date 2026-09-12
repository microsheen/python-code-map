describe('harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
  it('has jsdom document', () => {
    expect(typeof document).toBe('object');
  });
});
