# Drawn blocks

[TOC]

## Mermaid diagrams

A flowchart, with a line break in a label and a styled node:

```mermaid
graph TD;
  A[Start] --> B{Is it?};
  B -- Yes --> C[OK<br>two lines];
  B -- No --> D[End];
  style D fill:#f9f,stroke:#333
```

A sequence diagram:

```mermaid
sequenceDiagram
  Alice->>Bob: Hello Bob, how are you?
  Bob-->>Alice: Fine, thanks.
```

A class diagram:

```mermaid
classDiagram
  Animal <|-- Duck
  Animal : +int age
  Duck : +swim()
```

A state diagram:

```mermaid
stateDiagram-v2
  [*] --> Still
  Still --> Moving
  Moving --> [*]
```

An entity relationship diagram:

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
```

A Gantt chart:

```mermaid
gantt
  title A Gantt chart
  dateFormat YYYY-MM-DD
  section Work
  Write :a1, 2024-01-01, 30d
  Review :after a1, 10d
```

A pie chart:

```mermaid
pie title Pets
  "Dogs" : 386
  "Cats" : 85
```

A mind map:

```mermaid
mindmap
  root((Notes))
    Reading
    Writing
```

A git graph:

```mermaid
gitGraph
  commit
  branch develop
  commit
  checkout main
  merge develop
```

A user journey:

```mermaid
journey
  title A day
  section Morning
    Make tea: 5: Me
```

One with a mistake, which shows a message in its place:

```mermaid
graph TD;
  A-->
```

## Embedded notes

A whole note, a section and a block, each on a line of its own:

![[Other note]]

![[Other note#Part two]]

![[Other note#^quote-1]]

An embed of a note that is not there:

![[Missing]]

## Block ids

A paragraph with an id at its end. ^para-1

- one
- two ^item-2

## Git's conflict markers

A conflict git left after a merge:

<<<<<<< HEAD
Budget: 4,200, agreed with Dana on the 12th.
=======
Budget: 4,500.
>>>>>>> north-wall

With the lines as they were before either change, as git writes them when set to:

<<<<<<< HEAD
- Paint the north wall.
||||||| 1a2b3c4
- Paint the walls.
=======
- Paint the walls blue.
>>>>>>> north-wall
