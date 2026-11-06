#lang racket/base

(require racket/file racket/list racket/set racket/string "common.rkt" "source.rkt")
(provide main organize-definitions)

(struct definition (form id rhs parameters body) #:transparent)
(define builtins (make-base-namespace))
(parameterize ([current-namespace builtins]) (namespace-require 'racket))
(define builtin-procedure-cache (make-hasheq))
(define (builtin-procedure? name)
  ;; Some Racket procedures are exported through identifier transformers.
  ;; Resolve only a bare identifier in our own standard namespace.
  (hash-ref! builtin-procedure-cache name
             (lambda ()
               (with-handlers ([exn:fail? (lambda (_) #f)])
                 (procedure? (eval name builtins))))))
(define supported-syntax '(quote quasiquote unquote unquote-splicing lambda λ let let* letrec
                                if begin begin0 and or cond else => when unless set! define
                                #%app #%datum #%top #%expression))

(define (refuse stx message)
  (error 'organize "~a~a; no changes made"
         message (if (and (syntax? stx) (syntax-line stx)) (format " (line ~a)" (syntax-line stx)) "")))
(define (pieces stx)
  (or (syntax->list stx) (refuse stx "Unsupported dotted expression")))
(define (head stx)
  (define xs (and (syntax? stx) (syntax->list stx)))
  (and (pair? xs) (identifier? (car xs)) (syntax-e (car xs))))

(define (read-forms path text)
  ;; Only the standard reader is used; no project reader or macro is executed.
  (define header-end (structure-header-end text))
  (unless header-end (refuse #f "Expected #lang racket, racket/base, or racket/load"))
  (define in (open-input-string text))
  (port-count-lines! in)
  (read-string header-end in)
  (parameterize ([read-accept-reader #f] [read-accept-lang #f] [read-accept-graph #f] [read-accept-compiled #f])
    (let loop ([result '()])
      (define stx (read-syntax path in))
      (if (eof-object? stx) (reverse result) (loop (cons stx result))))))

(define (parse-definition form)
  (and (eq? (head form) 'define)
       (let ([xs (pieces form)])
         (unless (>= (length xs) 3) (refuse form "Incomplete definition"))
         (define target (cadr xs))
         (cond
           [(identifier? target)
            (unless (= (length xs) 3) (refuse form "Unsupported definition"))
            (define rhs (caddr xs))
            (define body (and (memq (head rhs) '(lambda λ)) (pieces rhs)))
            (when (and body (< (length body) 3)) (refuse rhs "Incomplete lambda"))
            (definition form target rhs (and body (cadr body)) (and body (cddr body)))]
           [else
            (define target-pair (syntax-e target))
            (unless (and (pair? target-pair) (identifier? (car target-pair)))
              (refuse target "Unsupported definition target"))
            (definition form (car target-pair) #f
              (datum->syntax target (cdr target-pair) target) (cddr xs))]))))

(define (organize-definitions path text)
  (define source (read-forms path text))
  (define definitions (filter-map parse-definition source))
  (define groups (make-hasheq))
  (for ([d (in-list definitions)])
    (hash-update! groups (syntax-e (definition-id d)) (lambda (ds) (cons d ds)) '()))
  (define repeated
    (for/hasheq ([(name ds) (in-hash groups)] #:when (> (length ds) 1)) (values name (reverse ds))))
  (cond
    [(zero? (hash-count repeated)) (hasheq 'edits '() 'count 0)]
    [else
     (for ([form (in-list source)]
           #:when (memq (head form) '(require provide define-syntax define-syntaxes define-syntax-rule
                                     define-values begin-for-syntax struct module module* module+)))
       (refuse form (format "~a requires manual editing" (head form))))
     (define occupied (list->mutable-seteq (namespace-mapped-symbols builtins)))
     (define (reserve value)
       (cond [(identifier? value) (set-add! occupied (syntax-e value))]
             [(syntax? value) (reserve (syntax-e value))]
             [(pair? value) (reserve (car value)) (reserve (cdr value))]
             [(vector? value) (for ([item (in-vector value)]) (reserve item))]
             [(box? value) (reserve (unbox value))]))
     (for-each reserve source)
     (define names (make-hasheq))
     (define edits (make-hash))
     (for ([(name ds) (in-hash repeated)])
       (define suffix 0)
       (for ([d (in-list (drop-right ds 1))])
         (define fresh
           (let loop ()
             (define candidate (string->symbol (format "~a~a" name suffix)))
             (set! suffix (add1 suffix))
             (if (set-member? occupied candidate) (loop) candidate)))
         (set-add! occupied fresh)
         (hash-set! names d fresh)))
     (define (edit id d)
       (when (hash-has-key? names d)
         (define start (sub1 (syntax-position id)))
         (hash-set! edits start
                    (hasheq 'start start 'end (+ start (syntax-span id))
                            'text (format "~s" (hash-ref names d))))))
     (define active (make-hasheq))
     (define top-names (list->seteq (hash-keys groups)))
     (define (bind ids locals)
       (for/fold ([scope locals]) ([id (in-list ids)])
         (unless (identifier? id) (refuse id "Unsupported local binding"))
         (when (memq (syntax-e id) supported-syntax) (refuse id "A binding shadows supported syntax"))
         (set-add scope (syntax-e id))))
     (define (parameters stx)
       (cond [(identifier? stx) (list stx)]
             [else
              (let loop ([value (syntax-e stx)])
                (cond [(null? value) '()]
                      [(syntax? value) (parameters value)]
                      [(pair? value)
                       (unless (identifier? (car value)) (refuse stx "Optional or keyword parameters require manual editing"))
                       (cons (car value) (loop (cdr value)))]
                      [else (refuse stx "Unsupported parameters")]))]))
     (define (reference id locals delayed owner operator?)
       (define name (syntax-e id))
       (unless (set-member? locals name)
         (when (or (memq name '(eval eval-syntax load load-relative dynamic-require current-namespace current-eval current-load))
                   (string-prefix? (symbol->string name) "namespace-"))
           (refuse id "Dynamic evaluation requires manual editing"))
         (when (hash-has-key? repeated name)
           (define d (hash-ref active name #f))
           (unless d (refuse id "Reference before the first definition"))
           (when (and owner (eq? name (syntax-e (definition-id owner))) (not delayed))
             (refuse id "An initializer reads its previous definition"))
           ;; Only direct self recursion is assigned to an earlier function
           ;; version. Other delayed references may observe later redefinitions.
           (when (and delayed (hash-has-key? names d) (not (eq? d owner)))
             (refuse id "A delayed reference may observe a later definition"))
           (when (and (definition-body d) (hash-has-key? names d) (not operator?))
             (refuse id "An earlier function version escapes as a value"))
           (edit id d))))
     (define (quoted value depth locals delayed owner)
       (cond
         [(syntax? value)
          (define xs (syntax->list value))
          (cond
            [(and (pair? xs) (memq (head value) '(unquote unquote-splicing quasiquote)))
             (unless (= (length xs) 2) (refuse value "Unsupported quasiquote"))
             (define next (+ depth (if (eq? (head value) 'quasiquote) 1 -1)))
             (if (zero? next) (walk (cadr xs) locals delayed owner #f)
                 (quoted (cadr xs) next locals delayed owner))]
            [else (quoted (syntax-e value) depth locals delayed owner)])]
         [(pair? value)
          ;; A list tail can itself be an escape, e.g. (x . ,a), even
          ;; when the reader represents that tail without a syntax wrapper.
          (when (and (identifier? (car value))
                     (memq (syntax-e (car value)) '(quasiquote unquote unquote-splicing)))
            (refuse (car value) "Quasiquote escapes in list tails require manual editing"))
          (quoted (car value) depth locals delayed owner)
          (quoted (cdr value) depth locals delayed owner)]
         [(vector? value) (for ([v (in-vector value)]) (quoted v depth locals delayed owner))]
         [(box? value) (quoted (unbox value) depth locals delayed owner)]
         [(hash? value) (refuse #f "Quasiquoted hash tables require manual editing")]
         [(prefab-struct-key value) (refuse #f "Quasiquoted prefab structures require manual editing")]))
     (define (walk-body expressions locals delayed owner)
       (define (splice-begin form)
         (if (eq? (head form) 'begin) (append-map splice-begin (cdr (pieces form))) (list form)))
       (define forms (append-map splice-begin expressions))
       (define definitions (filter-map parse-definition forms))
       (define ids (map definition-id definitions))
       (unless (= (length ids) (length (remove-duplicates (map syntax-e ids))))
         (refuse (car ids) "Duplicate internal definitions require manual editing"))
       ;; Internal definitions share a recursive scope, including forward
       ;; references and names that shadow a repeated top-level definition.
       (define scope (bind ids locals))
       (for ([form (in-list forms)])
         (define d (findf (lambda (d) (eq? form (definition-form d))) definitions))
         (cond
           [(not d) (walk form scope delayed owner #f)]
           [(definition-body d)
            (walk-body (definition-body d) (bind (parameters (definition-parameters d)) scope) #t #f)]
           [else (walk (definition-rhs d) scope delayed owner #f)])))
     (define (walk stx locals delayed owner operator?)
       (cond
         [(identifier? stx) (reference stx locals delayed owner operator?)]
         [(pair? (syntax-e stx))
          (define xs (pieces stx))
          (define tag (head stx))
          (define args (cdr xs))
          (define (walk-expressions expressions)
            (for ([expression (in-list expressions)]) (walk expression locals delayed owner #f)))
          (case tag
            [(quote) (unless (= (length args) 1) (refuse stx "Malformed quote"))]
            [(quasiquote)
             (unless (= (length args) 1) (refuse stx "Malformed quasiquote"))
             (quoted (car args) 1 locals delayed owner)]
            [(lambda λ)
             (when (and owner (not (definition-body owner))
                        (hash-has-key? repeated (syntax-e (definition-id owner))))
               (refuse stx "A duplicate initializer contains a delayed computation"))
             (unless (>= (length args) 2) (refuse stx "Incomplete lambda"))
             (define scope (bind (parameters (car args)) locals))
             ;; The top-level function body is handled separately. A nested
             ;; closure can outlive its version, so it gets no self-recursion
             ;; exception for references to earlier definitions.
             (walk-body (cdr args) scope #t #f)]
            [(let let* letrec)
             (unless (>= (length args) 2) (refuse stx "Incomplete let"))
             (when (identifier? (car args)) (refuse stx "Named let requires manual editing"))
             (define bindings (map pieces (pieces (car args))))
             (unless (andmap (lambda (b) (and (= (length b) 2) (identifier? (car b)))) bindings)
               (refuse stx "Unsupported let bindings"))
             (define scope (if (eq? tag 'letrec) (bind (map car bindings) locals) locals))
             (for ([b (in-list bindings)])
               (walk (cadr b) scope delayed owner #f)
               (when (eq? tag 'let*) (set! scope (bind (list (car b)) scope))))
             (walk-body (cdr args) (bind (map car bindings) locals) delayed owner)]
            [(if begin begin0 and or) (walk-expressions args)]
            [(when unless)
             (unless (pair? args) (refuse stx "Missing condition"))
             (walk (car args) locals delayed owner #f)
             (walk-body (cdr args) locals delayed owner)]
            [(define) (refuse stx "Definition outside a body")]
            [(cond)
             (for ([clause (in-list args)])
               (define cs (pieces clause))
               (when (null? cs) (refuse clause "Empty cond clause"))
               (unless (eq? (syntax-e (car cs)) 'else) (walk (car cs) locals delayed owner #f))
               (if (and (>= (length cs) 2) (eq? (syntax-e (cadr cs)) '=>))
                   (walk-expressions (cddr cs))
                   (walk-body (cdr cs) locals delayed owner)))]
            [(set!)
             (unless (and (= (length args) 2) (identifier? (car args))
                          (set-member? locals (syntax-e (car args))))
               (refuse stx "Top-level mutation requires manual editing"))
             (walk-expressions (cdr args))]
            [else
             (unless (or (and tag (or (set-member? locals tag) (set-member? top-names tag)
                                     (builtin-procedure? tag)))
                         (and (not tag) (pair? (syntax-e (car xs)))))
               (refuse stx (format "Unsupported syntax: ~a" (or tag "application"))))
             (walk (car xs) locals delayed owner #t)
             (walk-expressions args)])]
         [else (void)]))
     (for ([form (in-list source)])
       (define d (findf (lambda (d) (eq? form (definition-form d))) definitions))
       (cond
         [d
          (define name (syntax-e (definition-id d)))
          (when (memq name supported-syntax) (refuse (definition-id d) "A definition shadows supported syntax"))
          (hash-set! active name d)
          (edit (definition-id d) d)
          (if (definition-body d)
              (walk-body (definition-body d) (bind (parameters (definition-parameters d)) (seteq)) #t d)
              (walk (definition-rhs d) (seteq) #f d #f))]
         [else (walk form (seteq) #f #f #f)]))
     (hasheq 'edits (sort (hash-values edits) < #:key (lambda (e) (hash-ref e 'start)))
             'count (hash-count names))]))

(define (main)
  (serve (lambda (method params)
           (unless (equal? method "organize") (error 'organize "Unknown request"))
           (organize-definitions (hash-ref params 'path) (hash-ref params 'text)))))

;; The batch entry point applies the same all-or-nothing operation to each file.
(module+ main
  (define args (vector->list (current-command-line-arguments)))
  (unless (and (pair? args) (equal? (car args) "--write") (pair? (cdr args)))
    (error 'organize "Usage: racket organize.rkt --write file ..."))
  (for ([path (in-list (cdr args))])
    (with-handlers ([exn:fail? (lambda (e) (eprintf "~a: ~a\n" path (exn-message e)))])
      (define original (file->string path))
      (define text (normalize-text original))
      (define result (organize-definitions path text))
      (define edits (hash-ref result 'edits))
      (unless (null? edits)
        ;; Translate normalized reader positions back to original CRLF offsets.
        (define positions
          (list->vector
           (let loop ([i 0])
             (cons i (if (= i (string-length original)) '()
                         (loop (+ i (if (and (char=? (string-ref original i) #\return)
                                             (< (add1 i) (string-length original))
                                             (char=? (string-ref original (add1 i)) #\newline)) 2 1))))))))
        (define updated
          (for/fold ([value original]) ([e (in-list (reverse edits))])
            (string-append (substring value 0 (vector-ref positions (hash-ref e 'start)))
                           (hash-ref e 'text)
                           (substring value (vector-ref positions (hash-ref e 'end))))))
        (display-to-file updated path #:exists 'truncate/replace))
      (printf "~a: ~a definitions renamed\n" path (hash-ref result 'count)))))
