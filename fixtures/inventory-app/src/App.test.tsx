import { render, screen } from "@testing-library/react";
import App from "./App";

it("renders the starter placeholder", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /placeholder app/i })).toBeInTheDocument();
});
