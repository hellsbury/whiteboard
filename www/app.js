/**
 ******************************************************************************
 * Globals
 ******************************************************************************
 */

// Note: eventually this JSON object will come from the server
const state = {
  boardState: {
    columns: [
      {
        id: 1,
        title: "First Column",
        cards: [
          { id: 2, title: "something to do" },
          { id: 3, title: "idk anymore" },
          {
            id: 4,
            title: "a third card how about that",
            description:
              "here is a longer description that will only be shown whenever the modal is showing",
          },
        ],
      },
      {
        id: 5,
        title: "Second Column",
        cards: [{ id: 6, title: "something I already did" }],
      },
      {
        id: 7,
        title: "Third Column",
        cards: [{ id: 8, title: "lorum ipsum" }],
      },
    ],
  },
};

/** @type {HlCardModal} */
const modalDialog = document.getElementById("card-modal");
/** @type {HlColumnsContainer} */
const board = document.getElementById("columns-container");

// Used to toggle the theme
const html = document.querySelector('html');
const themeToggle = document.getElementById('theme-toggle');

themeToggle.addEventListener('change', function () {
  if (themeToggle.checked) {
    html.style.setProperty("color-scheme", "light");
  } else {
    html.style.setProperty("color-scheme", "dark");
  }
});


/**
 ******************************************************************************
 * UI Components
 ******************************************************************************
 */

class HlColumnsContainer extends HTMLElement {
  static observedAttributes = [];

  constructor() {
    super();
  }

  connectedCallback() {
    console.debug("hl-columns-parent: added to page");
    this.render();
  }

  render() {
    const columns = state.boardState.columns
      .map((column, i) => {
        const cards = column.cards
          .map((card) => {
            return `<button
                  id="hl-card-${card.id}"
                  is="hl-card"
                  class="column__card"
                  card-id="${card.id}"
                  card-title="${card.title}"
                  column-idx="${i}"
                  draggable="true"
                  card-description="${card.description ?? ""}"
                >
                </button>
              `;
          })
          .join("");

        const template = `
        <div class="column">
          <input class="column-title" value="${column.title}" />
          <hl-cards column-idx="${i}">
            ${cards}
          </hl-cards>
          <button class="column__add-button">+ add new card</button>
          <button class="column__delete-button">delete column</button>
        </div>
        `;

        return template;
      })
      .join("\n");

    this.innerHTML = `
      ${columns}
      <div class="new-column-container">
        <button class="new-column-container__button">+ New Column</button>
      </div>
    `;

    /** @type {HTMLButtonElement} */
    const newColButton = this.querySelector(".new-column-container__button");
    newColButton.addEventListener("click", () => {
      dispatch(
        {
          type: "ADD_COL",
        },
        true,
      );
    });

    /** @type {HTMLButtonElement[]} */
    const addButtons = this.querySelectorAll(".column__add-button");
    const onButtonClick = (i) => () => {
      modalDialog.createNewCard(i);
    };
    addButtons.forEach((button, i) => button.addEventListener("click", onButtonClick(i)));

    /** @type {HTMLButtonElement[]} */
    const deleteButtons = this.querySelectorAll(".column__delete-button");
    const onDeleteColClick = (i) => () => {
      dispatch({ type: "DELETE_COL", data: { idx: i } }, true);
    };
    deleteButtons.forEach((button, i) => button.addEventListener("click", onDeleteColClick(i)));

    /** @type {HTMLInputElement[]} */
    const inputs = this.querySelectorAll(".column-title");
    const onTitleChange = (i) => (event) => {
      dispatch({
        type: "UPDATE_COL_TITLE",
        data: {
          idx: i,
          title: event.target.value,
        },
      });
    };

    inputs.forEach((input, i) => {
      input.addEventListener("change", onTitleChange(i));
    });
  }

  disconnectedCallback() {
    console.debug("hl-columns-parent: disconnected from page");
  }

  attributeChangedCallback(name, oldValue, newValue) {
    // TODO: eventually we probably want the parent element listening to global
    // state from the server, and re-painting all children when we get a new
    // state object.  For now, we can't really change the state (except locally,
    // by dragging, dropping, or editing text -- all of which will be reflected
    // without editing server state, since we're doing it locally).
    console.debug(
      `hl-columns-parent: attribute ${name} has changed from ${oldValue} to ${newValue}`,
    );
  }
}

class HlCards extends HTMLElement {
  static observedAttributes = ["column-idx"];

  constructor() {
    super();

    this.columnIdx = 0;

    this.addEventListener("drop", this.onDrop.bind(this));
    this.addEventListener("dragover", this.onDragOver.bind(this));
  }

  connectedCallback() {
    console.debug("hl-cards: added to page");
  }

  disconnectedCallback() {
    console.debug("hl-cards: disconnected from page");
  }

  attributeChangedCallback(name, oldValue, newValue) {
    console.debug(`hl-cards: attribute ${name} has changed from ${oldValue} to ${newValue}`);

    switch (name) {
      case "column-idx":
        this.columnIdx = Number(newValue);
        break;
    }
  }

  onDrop(event) {
    event.preventDefault();
    console.debug("hl-cards: onDrop:", event);
    // get the card and the column it came from:
    const draggingCard = document.getElementById(event.dataTransfer.getData("text/plain"));

    let newIndex = 0;
    if (this.children.length == 0) {
      this.insertBefore(draggingCard, null);
      newIndex = 0;
    } else {
      const newCardIdx = getReferenceCardIndex(this, event);
      this.insertBefore(draggingCard, this.children[newCardIdx] ?? null);
      newIndex = newCardIdx;
    }

    dispatch({
      type: "MOVE_CARD",
      data: {
        cardId: Number(draggingCard.getAttribute("card-id")),
        previousColumn: Number(draggingCard.getAttribute("column-idx")),
        newColumn: this.columnIdx,
        newIndex,
      },
    });

    // finally update the old card with its new location
    draggingCard.setAttribute("column-idx", this.columnIdx);
  }

  onDragOver(event) {
    // it's important to do this -- the browser will not recognize us as a valid
    // drop zone unless we define this function, even if doesn't do anything besides
    // prevent the default behavior (which is "stop, this isn't a valid dropzone")
    event.preventDefault();
  }
}

// given a target (parent), and a drop event, calculates the index of the card
// before which we should drop the new card.  May return 1 past the end of the
// children if the new card should be inserted at the end of the list.
function getReferenceCardIndex(target, event) {
  let idx = 0;
  Array.from(target.children).forEach((child, i) => {
    const r = child.getBoundingClientRect();
    if (event.clientY < r.bottom && event.clientY > r.top) {
      idx = i;
      const midpoint = r.top + r.height / 2;
      if (event.clientY > midpoint) {
        idx++;
      }
    }
  });
  let aboveFirst = false;
  let belowLast = false;
  if (idx == 0) {
    const fr = target.children[0].getBoundingClientRect();
    const lr = target.children[target.children.length - 1].getBoundingClientRect();
    if (fr.top > event.clientY) {
      aboveFirst = true;
    } else if (lr.bottom < event.clientY) {
      belowLast = true;
    }
  }
  if (aboveFirst) {
    idx = 0;
  } else if (belowLast) {
    idx = target.children.length;
  }
  return idx;
}

class HlCard extends HTMLButtonElement {
  static observedAttributes = ["card-id", "card-title", "card-description", "column-idx"];

  constructor() {
    super();

    this.cardId = 0;
    this.cardTitle = "";
    this.cardDescription = "";
    this.columnIdx = 0;

    this.addEventListener("dragstart", this.onDragStart.bind(this));
    this.addEventListener("click", this.onClick.bind(this));
  }

  connectedCallback() {
    console.debug("hl-card: added to page");
    this.render();
  }

  render() {
    // TODO: display only a little bit (N lines) of the description, if it's long
    const template = `
      <div class="column__card__title-container">
        <h3 class="column__card-title">${this.cardTitle}</h3>
        <button class="column__card__delete-button">X</button>
      </div>
      <p class="column__card-contents">${this.cardDescription}</p>
    `;

    this.innerHTML = template;

    const deleteButton = this.querySelector(".column__card__delete-button");
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "DELETE_CARD", data: { id: this.cardId, columnIdx: this.columnIdx } }, true);
    });
  }

  disconnectedCallback() {
    console.debug("hl-card: disconnected from page");
  }

  attributeChangedCallback(name, oldValue, newValue) {
    console.debug(`hl-card: attribute ${name} has changed from ${oldValue} to ${newValue}`);

    switch (name) {
      case "card-id":
        this.cardId = Number(newValue);
        break;
      case "card-title":
        this.cardTitle = newValue;
        break;
      case "card-description":
        this.cardDescription = newValue;
        break;
      case "column-idx":
        this.columnIdx = Number(newValue);
        break;
    }

    this.render();
  }

  onDragStart(event) {
    console.debug("hl-card: onDragStart:", event);
    event.dataTransfer.dropEffect = "move";
    event.dataTransfer.setData("text/plain", event.target.id);
  }

  onClick() {
    modalDialog.openCard({
      id: this.cardId,
      title: this.cardTitle,
      description: this.cardDescription,
    });
  }
}

class HlCardModal extends HTMLDialogElement {
  static observedAttributges = [];

  constructor() {
    super();

    this.card = {};
    this.mode = "EDIT";
  }

  connectedCallback() {
    console.debug("hl-card-modal: added to page");
  }

  disconnectedCallback() {
    console.debug("hl-card-modal: disconnected from page");
  }

  attributeChangedCallback(name, oldValue, newValue) {
    console.debug(`hl-card-modal: attribute ${name} has changed from ${oldValue} to ${newValue}`);
  }

  openCard(cardData) {
    console.debug("hl-card-modal: opening card:", cardData);
    this.mode = "EDIT";
    this.card = cardData;
    this.render();
    this.showModal();
  }

  createNewCard(columnIdx) {
    console.debug("hl-card-modal: creating new card");
    this.mode = "CREATE";
    this.createColumnIdx = columnIdx;
    this.card = {
      id: 0,
      title: "",
      description: "",
    };
    this.render();
    this.showModal();
  }

  render() {
    const template = `
      <p class="card-modal__id">Card ID: ${this.card.id}</p>
      <input type="text" value="${this.card.title}" class="card-modal__title" placeholder="Card Title!"></input>
      <textarea class="card-modal__description" placeholder="Enter a task description here!">${this.card.description}</textarea>
      <form method="dialog">
        <button class="card-modal__save">Save</button>
      </form>
    `;

    this.innerHTML = template;

    const button = this.querySelector("button");
    button.addEventListener("click", this.updateState.bind(this));
  }

  updateState() {
    if (this.mode === "EDIT") {
      const title = this.querySelector(".card-modal__title").value;
      const description = this.querySelector(".card-modal__description").value;
      dispatch(
        {
          type: "UPDATE_CARD",
          data: {
            id: this.card.id,
            title,
            description,
          },
        },
        true,
      );
    } else if (this.mode === "CREATE") {
      const title = this.querySelector(".card-modal__title").value;
      const description = this.querySelector(".card-modal__description").value;
      dispatch(
        {
          type: "CREATE_CARD",
          data: {
            columnIdx: this.createColumnIdx,
            title,
            description,
          },
        },
        true,
      );
    }
  }
}

window.customElements.define("hl-card", HlCard, { extends: "button" });
window.customElements.define("hl-cards", HlCards);
window.customElements.define("hl-columns-container", HlColumnsContainer);
window.customElements.define("hl-card-modal", HlCardModal, { extends: "dialog" });

/**
 ******************************************************************************
 * Global Event Handling
 ******************************************************************************
 */

// the key problem to solve here is that whenever the user edits data (e.g.
// drags a card, or types in a text box) we need to do two things:
//
// 1) make sure that the data they edited is reflected everywhere else on the
// screen (e.g. if they edit a card, then the card preview should show the edit)
// 2) broadcast the state update to all other clients on the same board
//
// Part #1 has to be somewhat intelligent, since many edits _don't_ require us
// to re-render.  For example, if you type in an input, obviously you don't need
// to re-render _that input_, since typing Just Works.  but if that same text is
// rendered _somewhere else_, then of course we should re-render.

// state changes that _do_ require re-painting the board: e.g. saving an edit modal
function dispatch(action, render = false) {
  console.debug("dispatch", action);
  switch (action.type) {
    // FIXME: this is probably a silly way to update the cards (just by
    // iterating all the cards on the board), but it works for now.
    case "UPDATE_CARD": {
      outer: for (const column of state.boardState.columns) {
        let i = 0;
        for (let card of column.cards) {
          if (card.id == action.data.id) {
            column.cards[i] = action.data;
            break outer;
          }
          i++;
        }
      }
      break;
    }
    case "MOVE_CARD": {
      const previousColumn = state.boardState.columns[action.data.previousColumn];
      const originalCardIdx = previousColumn.cards.findIndex((x) => x.id == action.data.cardId);
      const cardData = previousColumn.cards[originalCardIdx];
      const newColumn = state.boardState.columns[action.data.newColumn];

      // remove the card from the old column:
      previousColumn.cards.splice(originalCardIdx, 1);

      // add it to the new column:
      newColumn.cards.splice(action.data.newIndex, 0, cardData);
      break;
    }
    case "UPDATE_COL_TITLE": {
      state.boardState.columns[action.data.idx].title = action.data.title;
      break;
    }
    case "CREATE_CARD": {
      // FIXME: again, this is silly, and this would normally require
      // negotiation with the server (unless ids are just something we use locally)
      let maxId = 0;
      for (const col of state.boardState.columns) {
        maxId = Math.max(col.id, maxId);
        for (const card of col.cards) {
          maxId = Math.max(card.id, maxId);
        }
      }

      const { title, description } = action.data;

      state.boardState.columns[action.data.columnIdx].cards.push({
        id: maxId + 1,
        title,
        description,
      });
      break;
    }
    case "ADD_COL": {
      // FIXME: yeah, ok, we get it
      let maxId = 0;
      for (const col of state.boardState.columns) {
        maxId = Math.max(col.id, maxId);
        for (const card of col.cards) {
          maxId = Math.max(card.id, maxId);
        }
      }

      state.boardState.columns.push({ id: maxId + 1, title: "New Column", cards: [] });
      break;
    }
    case "DELETE_CARD": {
      const cardIdx = state.boardState.columns[action.data.columnIdx].cards.findIndex(
        (x) => x.id === action.data.id,
      );
      state.boardState.columns[action.data.columnIdx].cards.splice(cardIdx, 1);
      break;
    }
    case "DELETE_COL": {
      state.boardState.columns.splice(action.data.idx, 1);
      break;
    }
  }

  if (render) {
    board.render();
  }
}
