function showDocument(book) {
  const [designation, ...name] = book.heading.split(" — ");
  document.getElementById("designation").textContent = designation;
  const title = document.getElementById("document-name");
  title.textContent = name.join(" — ");
  title.hidden = !title.textContent;
  document.getElementById("pages").textContent = formatPages(book.total);
}

function formatPages(number) {
  const forms = { one: "страница", few: "страницы", many: "страниц" };
  const form = new Intl.PluralRules("ru").select(number);
  return number + " " + (forms[form] || forms.many);
}
