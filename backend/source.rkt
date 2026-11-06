#lang racket/base

(require racket/list "common.rkt")
(provide read-structure read-comment-range structure-header-end)

(define (structure-header-end text)
  (define in (open-input-string text))
  (port-count-lines! in)
  (define marker (gensym 'language-header))
  (define end #f)
  ;; Let the standard reader skip whitespace, BOMs and comments. Intercept the
  ;; declaration so identifying the header never loads a project reader.
  (define table
    (make-readtable
     #f #\l 'dispatch-macro
     (lambda (_character port _source _line _column _position)
       (unless (regexp-match #px"^ang[ \t]+(?:racket/base|racket/load|racket)[ \t]*(?:;[^\n]*)?(?:\n|$)" port)
         (error 'structure-header "Unsupported language declaration"))
       (define-values (_row _col position) (port-next-location port))
       (set! end (sub1 position))
       marker)))
  (with-handlers ([exn:fail? (lambda (_) #f)])
    (parameterize ([current-readtable table] [read-accept-reader #f] [read-accept-lang #f]
                   [read-accept-graph #f] [read-accept-compiled #f])
      (and (eq? (read in) marker) end))))

;; The lexer identifies the #; marker; the standard reader identifies the
;; complete datum that it discards, including quote prefixes and nested data.
(define (read-comment-range path text start end header-end)
  (and header-end
       (with-handlers ([exn:fail:read? (lambda (_) #f)])
         (define in (open-input-string text))
         (port-count-lines! in)
         (read-string end in)
         (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                        [read-accept-graph #f] [read-accept-compiled #f])
           (define stx (read-syntax path in))
           (define at (syntax-location stx))
           (and at (hasheq 'start start 'end (hash-ref at 'end)
                           'bodyStart (hash-ref at 'start)))))))

;; This reader-only view is also available when module expansion fails. Source
;; forms are not binding information; consumers must keep that distinction.
(define (read-structure path text header-end)
  (define (children-of value)
    (cond [(syntax? value) (list value)]
          [(pair? value) (append (children-of (car value)) (children-of (cdr value)))]
          [(vector? value) (append-map children-of (vector->list value))]
          [(box? value) (children-of (unbox value))]
          [(prefab-struct-key value) (children-of (struct->vector value))]
          [else '()]))
  (define (node stx)
    (define at (syntax-location stx))
    (cond
      [(not at) #f]
      [else
       (define start (hash-ref at 'start))
       (define end (hash-ref at 'end))
       (cond
         [(not (and (<= 0 start) (< start end) (<= end (string-length text)))) #f]
         [else
          (define value (syntax-e stx))
          (define plain-list? (memv (string-ref text start) '(#\( #\[ #\{)))
          (define kind
            (cond [(and plain-list? (syntax->list stx)) "list"]
                  [plain-list? "dotted"]
                  [(or (pair? value) (box? value)) "prefix"]
                  [(or (symbol? value) (keyword? value) (string? value)
                       (number? value) (boolean? value) (char? value)) "atom"]
                  [else "opaque"]))
          (define children
            (for*/list ([child (in-list (children-of value))]
                       [item (in-value (node child))]
                       #:when (and item (> (hash-ref item 'start) start) (<= (hash-ref item 'end) end)))
              item))
          (hasheq 'start start 'end end 'kind kind 'children children
                  'name (if (or (symbol? value) (keyword? value)) (format "~a" value) #f)
                  'atomKind (cond [(symbol? value) "symbol"] [(keyword? value) "keyword"] [else #f]))])]))
  (cond
    [(not header-end) (hasheq 'forms '() 'complete #f 'headerEnd #f)]
    [else
     (define in (open-input-string text))
     (port-count-lines! in)
     (read-string header-end in)
     (define forms '())
     (define complete? #t)
     (with-handlers ([exn:fail:read? (lambda (_) (set! complete? #f))])
       (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                      [read-accept-graph #f] [read-accept-compiled #f])
         (let loop ()
           (define stx (read-syntax path in))
           (unless (eof-object? stx)
             (define item (node stx))
             (when item (set! forms (cons item forms)))
             (loop)))))
     (hasheq 'forms (reverse forms) 'complete complete? 'headerEnd header-end)]))
