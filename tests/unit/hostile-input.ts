// Hostile values shared by the input-validation and email tests (issues 442, 758).

/** Hostile values a name or text field must never carry into an email or page. */
export const HOSTILE_TEXT = [
  "<script>alert(1)</script>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "<a href=\"https://evil.example\">Log in</a>",
  "https://evil.example/login",
  "www.evil.example",
  "Click here: evil.com",
  "javascript:alert(1)",
  "<img src=x onerror=alert(1)>",
  "Bob\" onmouseover=\"alert(1)",
  "{{7*7}}",
  "${process.env.SECRET}",
  "Ann <b>Smith</b>",
  "admin@evil.example",
];

