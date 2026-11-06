#lang racket/base

(require racket/class racket/list racket/path racket/port racket/string
         syntax-color/module-lexer syntax-color/lexer-contract syntax-color/paren-tree
         syntax-color/color-textoid syntax-color/racket-indentation syntax-color/racket-navigation
         drracket/find-module-path-completions "common.rkt" "source.rkt")
(provide main)

(struct token (start end attributes paren backup) #:transparent)
(define default-parens '((|(| |)|) (|[| |]|) (|{| |}|)))

(define (language-info text)
  (define in (open-input-string text))
  (port-count-lines! in)
  (or (with-handlers ([exn:fail:read? (lambda (_) #f)]) (read-language in (lambda () #f)))
      (lambda (_key default) default)))

(define textoid%
  (class* object% (color-textoid<%>)
    (init-field text)
    (super-new)
    (define info (language-info text))
    (define pairs (info 'drracket:paren-matches default-parens))
    (define parens (new paren-tree% [matches pairs]))
    (define tokens
      (let ([in (open-input-string text)])
        (port-count-lines! in)
        (let loop ([mode #f] [previous 0] [result '()])
          (define-values (_lexeme attrs paren start end backup next-mode)
            (module-lexer* in 0 mode))
          (define kind (if (hash? attrs) (hash-ref attrs 'type 'other) attrs))
          (cond
            [(eq? kind 'eof) (list->vector (reverse result))]
            [else
             (unless (and start end (> end start) (>= (sub1 start) previous))
               (error 'lexer "Language lexer returned a non-advancing or overlapping token"))
             (define table (if (hash? attrs) attrs (hasheq 'type attrs)))
             (define left (sub1 start))
             (define right (sub1 end))
             (when (> left previous) (send parens add-token #f (- left previous)))
             (send parens add-token paren (- right left)
                   #:invisible-opens (hash-ref table 'invisible-open-count 0)
                   #:invisible-closes (hash-ref table 'invisible-close-count 0))
             (loop (if (dont-stop? next-mode) (dont-stop-val next-mode) next-mode)
                   right (cons (token left right table paren backup) result))]))))
    (define lines
      (list->vector (cons 0 (for/list ([c (in-string text)] [i (in-naturals)] #:when (char=? c #\newline)) (add1 i)))))

    (define/public (get-info key default) (info key default))
    (define/public (get-tokens) tokens)
    (define/public (get-parens) parens)
    (define/public (get-text [start 0] [end 'eof])
      (substring text start (if (eq? end 'eof) (string-length text) end)))
    (define/public (get-character position)
      (if (<= 0 position (sub1 (string-length text))) (string-ref text position) #\nul))
    (define/public (last-position) (string-length text))
    (define/public (position-paragraph position [at-eol? #f])
      (define p (if (and at-eol? (> position 0) (char=? (get-character (sub1 position)) #\newline)) (sub1 position) position))
      (let loop ([lo 0] [hi (vector-length lines)])
        (if (>= lo hi) (max 0 (sub1 lo))
            (let ([mid (quotient (+ lo hi) 2)])
              (if (<= (vector-ref lines mid) p) (loop (add1 mid) hi) (loop lo mid))))))
    (define/public (paragraph-start-position paragraph [visible? #t])
      (vector-ref lines (min paragraph (sub1 (vector-length lines)))))
    (define/public (paragraph-end-position paragraph [visible? #t])
      (if (< (add1 paragraph) (vector-length lines))
          (sub1 (vector-ref lines (add1 paragraph))) (last-position)))
    (define/public (token-at position)
      (let loop ([lo 0] [hi (vector-length tokens)])
        (cond [(>= lo hi) #f]
              [else
               (define mid (quotient (+ lo hi) 2))
               (define t (vector-ref tokens mid))
               (cond [(< position (token-start t)) (loop lo mid)]
                     [(>= position (token-end t)) (loop (add1 mid) hi)]
                     [else t])])))
    (define/public (classify-position position)
      (define t (token-at position))
      (and t (hash-ref (token-attributes t) 'type 'other)))
    (define/public (classify-position* position)
      (define t (token-at position)) (and t (token-attributes t)))
    (define/public (get-token-range position)
      (define t (token-at position)) (values (and t (token-start t)) (and t (token-end t))))
    (define/public (get-backward-navigation-limit _position) 0)
    (define/public (get-regions) '((0 end)))
    (define/public (skip-whitespace position direction comments?)
      (let loop ([p position])
        (define t (token-at (if (eq? direction 'backward) (sub1 p) p)))
        (if (and t (or (eq? (hash-ref (token-attributes t) 'type) 'white-space)
                       (and comments? (or (eq? (hash-ref (token-attributes t) 'type) 'comment)
                                          (hash-ref (token-attributes t) 'comment? #f)))))
            (loop (if (eq? direction 'backward) (token-start t) (token-end t))) p)))
    (define/public (forward-match position cutoff)
      (define p (skip-whitespace position 'forward #t))
      (define t (token-at p))
      (and t
           (cond
             [(send parens is-close-pos? (token-start t)) #f]
             [(send parens is-open-pos? (token-start t))
              (define-values (start end error) (send parens match-forward (token-start t)))
              (and start end (not error) (<= end cutoff) end)]
             [else (and (<= (token-end t) cutoff) (token-end t))])))
    (define/public (backward-match position cutoff)
      (define p (skip-whitespace position 'backward #t))
      (define t (token-at (sub1 p)))
      (and t
           (cond
             [(send parens is-open-pos? (token-start t)) #f]
             [(send parens is-close-pos? (token-start t))
              (define-values (start end error) (send parens match-backward (token-end t)))
              (and start end (not error) (>= start cutoff) start)]
             [else (and (>= (token-start t) cutoff) (token-start t))])))
    (define/public (backward-containing-sexp position cutoff)
      (for/fold ([nearest #f]) ([t (in-vector tokens)]
                              #:when (and (>= (token-start t) cutoff)
                                          (< (token-start t) position)
                                          (send parens is-open-pos? (token-start t))))
        (define-values (_start end error) (send parens match-forward (token-start t)))
        (if (or error (not end) (> end position)) (token-end t) nearest)))
    (define/public (balanced-ranges)
      (for/fold ([ranges '()] #:result (reverse ranges))
                ([t (in-vector tokens)] #:when (send parens is-open-pos? (token-start t)))
        (define-values (_start end error) (send parens match-forward (token-start t)))
        (if (and end (not error))
            (cons (hasheq 'start (token-start t) 'end end 'openEnd (token-end t)
                          'closeStart (token-start (token-at (sub1 end)))) ranges)
            ranges)))))

;; Formatting standard Racket changes only whitespace between tokens. Keep the
;; original lexer and paren tree, translating positions as lines are indented.
;; Other languages can depend on indentation and still receive freshly lexed text.
(struct indentation-change (start end adjusted-start adjusted-end shift) #:transparent)
(define indentation-textoid%
  (class* object% (color-textoid<%>)
    (init-field original)
    (super-new)
    (define original-length (send original last-position))
    (define line-count (add1 (send original position-paragraph original-length)))
    (define changes (make-vector line-count #f))
    (define rows (make-vector line-count #f))
    (define count 0)
    (define/private (change-at position adjusted?)
      (let loop ([lo 0] [hi count])
        (if (>= lo hi)
            (and (> lo 0) (vector-ref changes (sub1 lo)))
            (let* ([mid (quotient (+ lo hi) 2)]
                   [change (vector-ref changes mid)]
                   [start (if adjusted? (indentation-change-adjusted-start change) (indentation-change-start change))])
              (if (<= start position) (loop (add1 mid) hi) (loop lo mid))))))
    (define/private (original-position position)
      (define change (change-at position #t))
      (cond [(not change) position]
            [(< position (indentation-change-adjusted-end change))
             (+ (indentation-change-start change)
                (min (- position (indentation-change-adjusted-start change))
                     (- (indentation-change-end change) (indentation-change-start change))))]
            [else (- position (indentation-change-shift change))]))
    (define/private (adjusted-position position [line-start? #f])
      (define change (and position (change-at position #f)))
      (cond [(not change) position]
            [(and line-start? (= position (indentation-change-start change)))
             (indentation-change-adjusted-start change)]
            [(< position (indentation-change-end change))
             (+ (indentation-change-adjusted-start change)
                (min (- position (indentation-change-start change))
                     (- (indentation-change-adjusted-end change) (indentation-change-adjusted-start change))))]
            [else (+ position (indentation-change-shift change))]))
    (define/public (reindent line leading replacement)
      (define start (paragraph-start-position line))
      (define original-start (send original paragraph-start-position line))
      (define original-end (+ original-start leading))
      (define shift (+ (- start original-start) (- (string-length replacement) leading)))
      (vector-set! changes count
                   (indentation-change original-start original-end start (+ start (string-length replacement)) shift))
      (set! count (add1 count))
      (define end (if (< (add1 line) line-count) (send original paragraph-start-position (add1 line)) original-length))
      (vector-set! rows line (string-append replacement (send original get-text original-end end))))
    (define/public (get-info key default) (send original get-info key default))
    (define/public (get-text [start 0] [end 'eof])
      (define stop (if (eq? end 'eof) (last-position) end))
      (if (= start stop) ""
          (apply string-append
                 (for/list ([line (in-range (position-paragraph start) (add1 (position-paragraph (sub1 stop))))])
                   (define left (paragraph-start-position line))
                   (define right (if (< (add1 line) line-count) (paragraph-start-position (add1 line)) (last-position)))
                   (define from (- (max start left) left))
                   (define to (- (min stop right) left))
                   (define row (vector-ref rows line))
                   (if row (substring row from to)
                       (let ([original-start (send original paragraph-start-position line)])
                         (send original get-text (+ original-start from) (+ original-start to))))))))
    (define/public (get-character position)
      (define change (change-at position #t))
      (if (and change (< position (indentation-change-adjusted-end change))) #\space
          (send original get-character (original-position position))))
    (define/public (last-position)
      (+ original-length (if (zero? count) 0 (indentation-change-shift (vector-ref changes (sub1 count))))))
    (define/public (position-paragraph position [at-eol? #f])
      (define p (if (and at-eol? (> position 0) (char=? (get-character (sub1 position)) #\newline)) (sub1 position) position))
      (send original position-paragraph (original-position p)))
    (define/public (paragraph-start-position paragraph [visible? #t])
      (adjusted-position (send original paragraph-start-position paragraph visible?) #t))
    (define/public (paragraph-end-position paragraph [visible? #t])
      (adjusted-position (send original paragraph-end-position paragraph visible?)))
    (define/public (token-at position)
      (define change (change-at position #t))
      (cond
        [(and change (< position (indentation-change-adjusted-end change)))
         (token (indentation-change-adjusted-start change) (indentation-change-adjusted-end change)
                (hasheq 'type 'white-space) #f 0)]
        [else
         (define t (send original token-at (original-position position)))
         (and t (token (adjusted-position (token-start t)) (adjusted-position (token-end t))
                       (token-attributes t) (token-paren t) (token-backup t)))]))
    (define/public (classify-position position)
      (define t (token-at position))
      (and t (hash-ref (token-attributes t) 'type 'other)))
    (define/public (classify-position* position)
      (define t (token-at position)) (and t (token-attributes t)))
    (define/public (get-token-range position)
      (define t (token-at position)) (values (and t (token-start t)) (and t (token-end t))))
    (define/public (get-backward-navigation-limit _position) 0)
    (define/public (get-regions) '((0 end)))
    (define/public (skip-whitespace position direction comments?)
      (adjusted-position (send original skip-whitespace (original-position position) direction comments?)))
    (define/public (forward-match position cutoff)
      (adjusted-position (send original forward-match (original-position position) (original-position cutoff))))
    (define/public (backward-match position cutoff)
      (adjusted-position (send original backward-match (original-position position) (original-position cutoff))))
    (define/public (backward-containing-sexp position cutoff)
      (adjusted-position (send original backward-containing-sexp (original-position position) (original-position cutoff))))))

(define current-document #f)
(define current-env #f)
(define document-custodian #f)
(define module-cache (box #f))

(define (inside-token? doc position)
  (define t (send doc token-at position))
  (and t (< (token-start t) position)
       (not (eq? (hash-ref (token-attributes t) 'type) 'white-space))))

(define (format-lines doc start end)
  (define first-line (send doc position-paragraph start))
  (define end-line (send doc position-paragraph end))
  (define ends-at-line-start?
    (and (> end start) (< end (send doc last-position))
         (= end (send doc paragraph-start-position end-line))))
  (define last-line (if ends-at-line-start? (send doc position-paragraph (sub1 end)) end-line))
  (define range-indentation (send doc get-info 'drracket:range-indentation #f))
  (define range-edits (and range-indentation (range-indentation doc start end)))
  (cond
    [range-edits
     (for/list ([change (in-list range-edits)] [line (in-naturals first-line)]
                #:when (and (<= line last-line) (not (inside-token? doc (send doc paragraph-start-position line)))))
       (define p (send doc paragraph-start-position line))
       (hasheq 'start p 'end (+ p (first change)) 'text (second change)))]
    [else
     (define reuse? (and (structure-header-end (send doc get-text)) (not (send doc get-info 'drracket:indentation #f))))
     (define working (if reuse? (new indentation-textoid% [original doc]) doc))
     (for/fold ([edits '()] #:result (reverse edits))
               ([line (in-range first-line (add1 last-line))]
                ;; Whitespace inside a multiline token is content, not indentation.
                #:unless (inside-token? working (send working paragraph-start-position line)))
       (define p (send working paragraph-start-position line))
       (define indent-proc (send working get-info 'drracket:indentation #f))
       (define spaces (or (and indent-proc (indent-proc working p)) (racket-amount-to-indent working p)))
       (define line-end (send working paragraph-end-position line))
       (define old-line (send working get-text p line-end))
       (define leading (string-length (car (regexp-match #px"^[ \t]*" old-line))))
       (define replacement (make-string spaces #\space))
       (cond
         [(equal? (substring old-line 0 leading) replacement) edits]
         [else
          (define original-p (send doc paragraph-start-position line))
          (if reuse?
              (send working reindent line leading replacement)
              (set! working (new textoid% [text (string-append (send working get-text 0 p) replacement (send working get-text (+ p leading)))])))
          (cons (hasheq 'start original-p 'end (+ original-p leading) 'text replacement) edits)]))]))

(define (module-completions prefix base)
  (define (find prefix directory)
    (find-module-path-completions/explicit-cache prefix directory #:pkg-dirs-cache module-cache))
  (define quoted? (string-prefix? prefix "\""))
  (define segments (regexp-split #rx"/" (if quoted? (substring prefix 1) prefix)))
  (define parents (drop-right segments 1))
  (cond
    [(null? parents) (find prefix base)]
    [(member "" parents) '()]
    [else
     ;; The library matches every segment by prefix; the editor replaces only
     ;; the last segment, so resolve the preceding directories exactly first.
     (define roots
       (if quoted? (list base)
           (for/list ([entry (in-list (find (car parents) base))]
                      #:when (and (equal? (first entry) (car parents))
                                  (directory-exists? (second entry))))
             (second entry))))
     (define directories (if quoted? parents (cdr parents)))
     (define name-prefix (string-append "\"" (last segments)))
     (append-map
      (lambda (root)
        (define directory
          (for/fold ([path root]) ([segment (in-list directories)])
            (build-path path (cond [(equal? segment ".") 'same]
                                   [(equal? segment "..") 'up]
                                   [else segment]))))
        (if (directory-exists? directory) (find name-prefix directory) '()))
      roots)]))

(define (dispatch-in-environment method params)
  (case (string->symbol method)
    [(document)
     (define path (environment-path current-env))
     (define text (environment-source current-env path))
     (set! current-document (new textoid% [text text]))
     (define header-end (structure-header-end text))
     (hasheq 'tokens
             (for/list ([t (in-vector (send current-document get-tokens))])
               (hasheq 'start (token-start t) 'end (token-end t)
                       'attributes (json-value (token-attributes t)) 'paren (json-value (token-paren t))
                       'backup (token-backup t)))
             'ranges (send current-document balanced-ranges)
             'comments
             (filter values
                     (for/list ([t (in-vector (send current-document get-tokens))]
                                #:when (eq? (hash-ref (token-attributes t) 'type) 'sexp-comment))
                       (read-comment-range path text (token-start t) (token-end t) header-end)))
             'structure (read-structure path text header-end))]
    [(format)
     (format-lines current-document (hash-ref params 'start) (hash-ref params 'end))]
    [(navigate)
     (define pos (hash-ref params 'position))
     (define direction (string->symbol (hash-ref params 'direction)))
     (define grouping (send current-document get-info 'drracket:grouping-position #f))
     (define limit (if (memq direction '(up backward)) 0 (send current-document last-position)))
     (or (and grouping (grouping current-document pos limit direction))
         (racket-grouping-position current-document pos limit direction))]
    [(expression)
     (define doc current-document)
     (define pos (hash-ref params 'position))
     (define t (send doc token-at pos))
     (define usable? (and (not (hash-ref params 'preceding #f))
                          t (not (memq (hash-ref (token-attributes t) 'type) '(white-space comment sexp-comment)))
                          (not (hash-ref (token-attributes t) 'comment? #f))))
     (define end
       (if usable?
           (if (send (send doc get-parens) is-close-pos? (token-start t))
               (token-end t) (racket-forward-sexp doc (token-start t)))
           (send doc skip-whitespace pos 'backward #t)))
     (define start (and end (racket-backward-sexp doc end)))
     (and start end (> end start) (hasheq 'start start 'end end))]
    [(modules)
     (for/list ([entry (in-list (module-completions
                                (hash-ref params 'prefix) (path-only (string->path (hash-ref params 'path)))))])
       (hasheq 'name (first entry) 'path (path->string (second entry))
               'directory (directory-exists? (second entry))))]
    [else (error 'lexical "Unknown request: ~a" method)]))

(define (dispatch method params)
  (when (equal? method "document")
    ;; A reused process still gives each document snapshot a fresh namespace
    ;; and releases ports or threads created by the previous language tools.
    (when document-custodian (custodian-shutdown-all document-custodian))
    (set! document-custodian (make-custodian))
    (set! current-document #f)
    (set! current-env #f)
    (set-box! module-cache #f)
    (parameterize ([current-custodian document-custodian])
      (set! current-env (make-environment params))))
  (unless current-env (error 'lexical "No document loaded"))
  (unless (equal? method "document")
    (update-overlays! current-env (hash-ref params 'documents #f)))
  (parameterize ([current-custodian document-custodian])
    (call-in-environment current-env (lambda () (dispatch-in-environment method params))
                         #:record-dependencies? (not (equal? method "modules")))))

(define (main)
  (serve dispatch #:dependencies
         (lambda () (and current-env (hash-keys (environment-dependencies current-env))))))
