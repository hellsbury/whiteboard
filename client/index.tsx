import "preact/debug";
import { nanoid } from "nanoid";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { render } from "preact";
import { useRef, useEffect } from "preact/hooks";
import type { ChangeEvent, DragEvent, MouseEvent, FormEvent } from "preact/compat";

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(`AssertionError: ${message ?? String(condition)} was not true`);
  }
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("root div with id #root was not found.  unable to render application");
}

interface Card {
  id: string;
  title: string;
  description: string;
}

interface Column {
  cards: string[];
  id: string;
  title: string;
}

interface BoardStore {
  dialogState: {
    open: boolean;
    mode: "edit" | "create";
    columnIndex: number;
    card: Card;
  };
  cards: Record<string, Card>;
  columns: Column[];

  updateColumnTitle: (id: string, title: string) => void;
  removeColumn: (columnIndex: number) => void;
  addColumn: () => void;
  moveCard: (
    id: string,
    previousColumnIndex: number,
    newColumnIndex: number,
    newCardIndex: number,
  ) => void;
  deleteCard: (columnIndex: number, cardId: string) => void;
  addCard: (card: Omit<Card, "id">, columnIndex: number) => void;
  updateCard: (card: Card) => void;
  updateDialogCardState: (card: Partial<Card>) => void;
  openDialog: (columnIndex: number, mode: "edit" | "create", card?: Card) => void;
  closeDialog: () => void;
}

const useStore = create<BoardStore>((set) => ({
  dialogState: {
    open: false,
    columnIndex: 0,
    mode: "create",
    card: {
      id: "",
      title: "",
      description: "",
    },
  },
  cards: {
    a: {
      id: "a",
      title: "something to do",
      description: "reasonably long description that specifies what the task is or whatever",
    },
    b: {
      id: "b",
      title: "lorem ipsum",
      description: "dolor amat",
    },
  },
  columns: [
    { id: "a", title: "Backlog", cards: ["a"] },
    { id: "b", title: "On Deck", cards: ["b"] },
  ],
  removeColumn: (columnIndex) =>
    set((state) => {
      const columns = [...state.columns];
      const cards = { ...state.cards };
      for (const cardId of columns[columnIndex].cards) {
        delete cards[cardId];
      }
      columns.splice(columnIndex, 1);
      return { columns, cards };
    }),
  addColumn: () =>
    set((state) => {
      const columns = [...state.columns, { id: nanoid(), title: "New Column", cards: [] }];
      return { columns };
    }),
  updateColumnTitle: (id, title) =>
    set((state) => {
      const idx = state.columns.findIndex((x) => x.id === id);
      assert(idx !== -1, `expected column with id ${id} to exist in the store`);

      const columns = [...state.columns];
      columns[idx].title = title;
      return { columns };
    }),
  deleteCard: (columnIndex, cardId) =>
    set((state) => {
      const columns = [...state.columns];
      const cards = { ...state.cards };
      const cardIdx = columns[columnIndex].cards.findIndex((x) => x === cardId);
      assert(cardIdx !== -1, `column ${columnIndex} did not have a card with id ${cardId} in it`);
      columns[columnIndex].cards.splice(cardIdx, 1);
      delete cards[cardId];
      return { cards, columns };
    }),
  moveCard: (id, previousColumnIndex, newColumnIndex, newCardIndex) =>
    set((state) => {
      const columns = [...state.columns];
      const currentIdx = columns[previousColumnIndex].cards.findIndex((x) => x === id);
      assert(
        currentIdx !== -1,
        `column ${previousColumnIndex} did not have a card with id ${id} in it`,
      );

      columns[previousColumnIndex].cards.splice(currentIdx, 1);
      columns[newColumnIndex].cards.splice(newCardIndex, 0, id);

      return { columns };
    }),
  addCard: (card, columnIndex) =>
    set((state) => {
      const columns = [...state.columns];
      const cards = { ...state.cards };

      const newCard = { ...card, id: nanoid() };
      cards[newCard.id] = newCard;
      columns[columnIndex].cards.splice(0, 0, newCard.id);

      return { columns, cards };
    }),
  openDialog: (columnIndex, mode, card) =>
    set((state) => {
      const dialogState = { ...state.dialogState, open: true, columnIndex, mode };
      if (card) {
        dialogState.card = card;
      } else {
        dialogState.card = {
          id: "",
          title: "",
          description: "",
        };
      }
      return { dialogState };
    }),
  closeDialog: () =>
    set((state) => {
      const dialogState = { ...state.dialogState, open: false };
      return { dialogState };
    }),
  updateDialogCardState: (card) =>
    set((state) => {
      const dialogState = { ...state.dialogState };
      dialogState.card = { ...dialogState.card, ...card };
      return { dialogState };
    }),
  updateCard: (card) =>
    set((state) => {
      const cards = { ...state.cards };
      cards[card.id] = card;
      return { cards };
    }),
}));

interface CardProps {
  parentIndex: number;
  card: Card;
}

const CloseIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 384 512"
    fill="currentColor"
    className={className}
  >
    <path d="M376.6 84.5c11.3-13.6 9.5-33.8-4.1-45.1s-33.8-9.5-45.1 4.1L192 206 56.6 43.5C45.3 29.9 25.1 28.1 11.5 39.4S-3.9 70.9 7.4 84.5L150.3 256 7.4 427.5c-11.3 13.6-9.5 33.8 4.1 45.1s33.8 9.5 45.1-4.1L192 306 327.4 468.5c11.3 13.6 31.5 15.4 45.1 4.1s15.4-31.5 4.1-45.1L233.7 256 376.6 84.5z" />
  </svg>
);

const CARD_ID_DATA_TYPE = "application/card-id";

function Card({ card, parentIndex }: CardProps) {
  const [openDialog, deleteCard] = useStore(
    useShallow((state) => [state.openDialog, state.deleteCard]),
  );
  const onDragStart = (e: DragEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.dataTransfer?.setData(CARD_ID_DATA_TYPE, JSON.stringify({ card, parentIndex }));
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    openDialog(parentIndex, "edit", card);
  };

  const onDeleteClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    deleteCard(parentIndex, card.id);
  };

  return (
    <button class="card" draggable onDragStart={onDragStart} onClick={onClick}>
      <div className="card__title-container">
        <p class="card__title">{card.title}</p>
        <button class="card__delete-button" onClick={onDeleteClick}>
          <CloseIcon />
        </button>
      </div>
      <p class="card__description">{card.description}</p>
    </button>
  );
}

interface ColumnProps {
  columnIdx: number;
  column: Column;
}

function Column({ column, columnIdx }: ColumnProps) {
  const [updateColumnTitle, cards, moveCard, openDialog, removeColumn] = useStore(
    useShallow((state) => [
      state.updateColumnTitle,
      state.cards,
      state.moveCard,
      state.openDialog,
      state.removeColumn,
    ]),
  );

  const onAddCardClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    openDialog(columnIdx, "create");
  };

  const onRemoveColumnClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    removeColumn(columnIdx);
  };

  const onColumnTitleUpdate = (e: ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    updateColumnTitle(column.id, e.currentTarget.value);
  };

  const onDragOver = (e: Event) => {
    e.preventDefault();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // decode the card data from the drag event:
    const cardProps = JSON.parse(e.dataTransfer?.getData(CARD_ID_DATA_TYPE)!) as CardProps;

    // determine at what index to place the new card:
    let newCardIdx = 0;
    while (true) {
      // goto in javascript :D
      if (e.currentTarget.children.length === 0) {
        break;
      }
      Array.from(e.currentTarget.children).forEach((child, i) => {
        const r = child.getBoundingClientRect();
        if (e.clientY < r.bottom && e.clientY > r.top) {
          newCardIdx = i;
        }

        // if the current mouse clientY falls above the midpoint of the card
        // that it intersects with, place the new card above the existing card,
        // otherwise place it below
        if (e.clientY > r.top + r.height / 2) {
          newCardIdx++;
        }
      });

      const aboveFirstChild = e.currentTarget.children[0].getBoundingClientRect().top > e.clientY;
      if (aboveFirstChild) {
        newCardIdx = 0;
        break;
      }

      const belowLastChild =
        e.currentTarget.children[e.currentTarget.children.length - 1].getBoundingClientRect()
          .bottom < e.clientY;
      if (belowLastChild) {
        newCardIdx = e.currentTarget.children.length;
      }

      break;
    }

    // place the card:
    moveCard(cardProps.card.id, cardProps.parentIndex, columnIdx, newCardIdx);
  };

  return (
    <div className="column">
      <input className="column__title" value={column.title} onChange={onColumnTitleUpdate} />
      <div className="column__cards-container" onDragOver={onDragOver} onDrop={onDrop}>
        {column.cards.map((c) => (
          <Card card={cards[c]} parentIndex={columnIdx} />
        ))}
      </div>
      <div className="column__buttons-container">
        <button type="button" className="button" onClick={onAddCardClick}>
          + Add Card
        </button>
        <button type="button" className="button" onClick={onRemoveColumnClick}>
          Remove Column
        </button>
      </div>
    </div>
  );
}

function Dialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dialogState, closeDialog] = useStore(
    useShallow((state) => [state.dialogState, state.closeDialog]),
  );

  useEffect(() => {
    if (dialogState.open) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [dialogState.open]);

  return (
    <dialog ref={dialogRef} onClose={closeDialog} className="dialog">
      {dialogState.open ? <DialogContents /> : null}
    </dialog>
  );
}

function DialogContents() {
  const [dialogState, columns, closeDialog, updateDialogCardState, addCard, updateCard] = useStore(
    useShallow((state) => [
      state.dialogState,
      state.columns,
      state.closeDialog,
      state.updateDialogCardState,
      state.addCard,
      state.updateCard,
    ]),
  );

  const onInputChange =
    (k: keyof Card) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      updateDialogCardState({ [k]: e.currentTarget.value });
    };

  const onFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    if (dialogState.mode === "create") {
      addCard(
        {
          title: formData.get("title") as string,
          description: formData.get("description") as string,
        },
        dialogState.columnIndex,
      );
    } else {
      updateCard(dialogState.card);
    }
    closeDialog();
  };

  const dialogTitle =
    dialogState.mode === "create"
      ? `Creating new card in "${columns[dialogState.columnIndex].title}"`
      : `Edit card in "${columns[dialogState.columnIndex].title}"`;

  return (
    <>
      <div className="dialog__title-container">
        <h1 className="dialog__title">{dialogTitle}</h1>
        <button className="dialog__close-button" onClick={closeDialog}>
          <CloseIcon />
        </button>
      </div>
      <form className="dialog__form" onSubmit={onFormSubmit}>
        <input
          className="dialog__input"
          value={dialogState.card.title}
          name="title"
          placeholder="Card Title"
          onChange={onInputChange("title")}
        />
        <textarea
          className="dialog__input"
          onChange={onInputChange("description")}
          name="description"
          placeholder="Card Description"
        >
          {dialogState.card.description}
        </textarea>
        <button type="submit" className="button dialog__save">
          Save
        </button>
      </form>
    </>
  );
}

function App() {
  const [columns, addColumn] = useStore(useShallow((state) => [state.columns, state.addColumn]));
  return (
    <>
      <div class="board">
        {columns.map((c, i) => (
          <Column column={c} columnIdx={i} />
        ))}
        <div className="board__add-column">
          <button className="button" onClick={addColumn}>
            + Add Column
          </button>
        </div>
      </div>
      <Dialog />
    </>
  );
}

render(<App />, root);
